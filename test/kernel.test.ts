import assert from "node:assert/strict";
import test from "node:test";
import { AgentGovernanceKernel, GovernanceError } from "../src/kernel.ts";

const SPEC = "sha256:approved-work-plan-v1";

function createKernel(options: { calls?: number; tokens?: number; cost?: number } = {}) {
  const kernel = new AgentGovernanceKernel(() => new Date("2026-08-23T12:00:00.000Z"));
  let notifications = 0;

  kernel.registerTool({
    name: "knowledge.search",
    capability: "knowledge:read",
    risk: "low",
    estimate: () => ({ tokens: 25, costCents: 1 }),
    execute: async ({ query }: { query: string }) => ({ results: [`Grounded result for ${query}`] }),
  });

  kernel.registerTool({
    name: "customer.notify",
    capability: "customer:write",
    risk: "high",
    requiresApproval: true,
    estimate: () => ({ tokens: 10, costCents: 2 }),
    execute: async ({ message }: { message: string }) => {
      notifications += 1;
      return { delivered: true, message };
    },
  });

  kernel.createRun({
    id: "run-001",
    specHash: SPEC,
    grants: [
      { capability: "knowledge:read", allowedTools: ["knowledge.search"] },
      { capability: "customer:write", allowedTools: ["customer.notify"] },
    ],
    budget: {
      toolCalls: options.calls ?? 3,
      tokens: options.tokens ?? 100,
      costCents: options.cost ?? 10,
    },
  });

  return { kernel, notifications: () => notifications };
}

test("default-deny blocks tools outside the capability grant", async () => {
  const kernel = new AgentGovernanceKernel();
  kernel.registerTool({
    name: "billing.refund",
    capability: "billing:write",
    risk: "high",
    estimate: () => ({ tokens: 1, costCents: 0 }),
    execute: async () => ({ refunded: true }),
  });
  kernel.createRun({
    id: "run-denied",
    specHash: SPEC,
    grants: [],
    budget: { toolCalls: 1, tokens: 10, costCents: 1 },
  });

  await assert.rejects(
    kernel.requestTool({
      runId: "run-denied",
      specHash: SPEC,
      tool: "billing.refund",
      input: { amount: 100 },
      idempotencyKey: "refund-1",
    }),
    (error: unknown) => error instanceof GovernanceError && error.code === "CAPABILITY_DENIED",
  );
});

test("a mismatched specification is rejected before tool execution", async () => {
  const { kernel } = createKernel();
  await assert.rejects(
    kernel.requestTool({
      runId: "run-001",
      specHash: "sha256:tampered-plan",
      tool: "knowledge.search",
      input: { query: "maize" },
      idempotencyKey: "search-1",
    }),
    (error: unknown) => error instanceof GovernanceError && error.code === "SPEC_MISMATCH",
  );
});

test("budgets fail closed before an over-limit call", async () => {
  const { kernel } = createKernel({ tokens: 20 });
  await assert.rejects(
    kernel.requestTool({
      runId: "run-001",
      specHash: SPEC,
      tool: "knowledge.search",
      input: { query: "rainfall" },
      idempotencyKey: "search-budget",
    }),
    (error: unknown) => error instanceof GovernanceError && error.code === "BUDGET_EXCEEDED",
  );
  assert.deepEqual(kernel.getRun("run-001").usage, { toolCalls: 0, tokens: 0, costCents: 0 });
});

test("high-risk tools require a scoped, single-use approval", async () => {
  const { kernel, notifications } = createKernel();
  const request = {
    runId: "run-001",
    specHash: SPEC,
    tool: "customer.notify",
    input: { message: "Your report is ready" },
    idempotencyKey: "notify-42",
  };

  const first = await kernel.requestTool(request);
  assert.equal(first.status, "approval_required");
  assert.equal(notifications(), 0);

  if (first.status !== "approval_required") throw new Error("Expected approval request");
  kernel.approve(first.approvalRequestId, "reviewer@example.test");
  const executed = await kernel.requestTool({ ...request, approvalRequestId: first.approvalRequestId });

  assert.equal(executed.status, "executed");
  assert.equal(notifications(), 1);
});

test("idempotency prevents duplicate side effects", async () => {
  const { kernel, notifications } = createKernel();
  const request = {
    runId: "run-001",
    specHash: SPEC,
    tool: "customer.notify",
    input: { message: "One delivery only" },
    idempotencyKey: "notify-once",
  };
  const pending = await kernel.requestTool(request);
  if (pending.status !== "approval_required") throw new Error("Expected approval request");
  kernel.approve(pending.approvalRequestId, "reviewer@example.test");
  const first = await kernel.requestTool({ ...request, approvalRequestId: pending.approvalRequestId });
  const replay = await kernel.requestTool({ ...request, approvalRequestId: pending.approvalRequestId });

  assert.equal(first.status, "executed");
  assert.equal(replay.status, "executed");
  if (replay.status === "executed") assert.equal(replay.idempotentReplay, true);
  assert.equal(notifications(), 1);
});

test("audit receipts form a tamper-evident hash chain", async () => {
  const { kernel } = createKernel();
  await kernel.requestTool({
    runId: "run-001",
    specHash: SPEC,
    tool: "knowledge.search",
    input: { query: "soil" },
    idempotencyKey: "search-audit",
  });
  const log = kernel.getAuditLog("run-001");
  assert.equal(kernel.validateAuditChain("run-001", log), true);

  log[1] = { ...log[1], event: "tool.executed.without-controls" };
  assert.equal(kernel.validateAuditChain("run-001", log), false);
});

test("memory promotion requires verification and human approval", () => {
  const { kernel } = createKernel();
  kernel.stageMemory("run-001", "customer.preference", { language: "ha" });
  assert.throws(
    () => kernel.promoteMemory("run-001", "customer.preference"),
    (error: unknown) => error instanceof GovernanceError && error.code === "MEMORY_NOT_GOVERNED",
  );
  kernel.verifyMemory("run-001", "customer.preference");
  kernel.approveMemory("run-001", "customer.preference", "reviewer@example.test");
  assert.equal(kernel.promoteMemory("run-001", "customer.preference").promoted, true);
});

