import { createHash, randomUUID } from "node:crypto";
import type {
  ApprovalRequest,
  AuditReceipt,
  BudgetUsage,
  CapabilityGrant,
  ExecutionResult,
  MemoryCandidate,
  RunRecord,
  ToolDefinition,
  ToolRequest,
  ToolResult,
} from "./types.ts";

export class GovernanceError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GovernanceError";
    this.code = code;
  }
}

type Clock = () => Date;

export class AgentGovernanceKernel {
  private readonly runs = new Map<string, RunRecord>();
  private readonly tools = new Map<string, ToolDefinition<any, any>>();
  private readonly approvals = new Map<string, ApprovalRequest>();
  private readonly executions = new Map<string, ExecutionResult<any>>();
  private readonly receipts = new Map<string, AuditReceipt[]>();
  private readonly memory = new Map<string, MemoryCandidate>();
  private readonly clock: Clock;

  constructor(clock: Clock = () => new Date()) {
    this.clock = clock;
  }

  registerTool<Input, Output>(definition: ToolDefinition<Input, Output>): void {
    if (this.tools.has(definition.name)) {
      throw new GovernanceError("DUPLICATE_TOOL", `Tool already registered: ${definition.name}`);
    }
    this.tools.set(definition.name, definition);
  }

  createRun(input: {
    id: string;
    specHash: string;
    grants: CapabilityGrant[];
    budget: RunRecord["budget"];
    expiresAt?: string;
  }): RunRecord {
    if (this.runs.has(input.id)) {
      throw new GovernanceError("DUPLICATE_RUN", `Run already exists: ${input.id}`);
    }
    const run: RunRecord = {
      id: input.id,
      specHash: input.specHash,
      status: "active",
      grants: structuredClone(input.grants),
      budget: { ...input.budget },
      usage: { toolCalls: 0, tokens: 0, costCents: 0 },
      createdAt: this.now(),
      expiresAt: input.expiresAt,
    };
    this.runs.set(run.id, run);
    this.appendReceipt(run.id, "run.created", {
      specHash: run.specHash,
      budget: run.budget,
      grants: run.grants,
    });
    return structuredClone(run);
  }

  getRun(runId: string): RunRecord {
    return structuredClone(this.requireRun(runId));
  }

  completeRun(runId: string): RunRecord {
    const run = this.requireRun(runId);
    this.assertActive(run);
    run.status = "completed";
    this.appendReceipt(runId, "run.completed", { usage: run.usage });
    return structuredClone(run);
  }

  async requestTool<Input, Output>(request: ToolRequest<Input>): Promise<ToolResult<Output>> {
    const replayKey = `${request.runId}:${request.idempotencyKey}`;
    const replay = this.executions.get(replayKey);
    if (replay) {
      return { ...structuredClone(replay), idempotentReplay: true };
    }

    const run = this.requireRun(request.runId);
    this.assertActive(run);
    this.assertPinnedSpec(run, request.specHash);

    const tool = this.tools.get(request.tool) as ToolDefinition<Input, Output> | undefined;
    if (!tool) throw new GovernanceError("UNKNOWN_TOOL", `Unknown tool: ${request.tool}`);
    this.assertCapability(run, tool.capability, tool.name);

    const estimate = tool.estimate(request.input);
    this.assertBudget(run, {
      toolCalls: 1,
      tokens: estimate.tokens,
      costCents: estimate.costCents,
    });

    if (tool.requiresApproval || tool.risk === "high") {
      const approval = request.approvalRequestId
        ? this.requireApproval(request.approvalRequestId)
        : undefined;

      if (!approval) {
        const pending = this.findOrCreateApproval(request, tool.name);
        this.appendReceipt(run.id, "approval.required", {
          approvalRequestId: pending.id,
          tool: tool.name,
          idempotencyKey: request.idempotencyKey,
        });
        return {
          status: "approval_required",
          approvalRequestId: pending.id,
          reason: pending.reason,
        };
      }

      this.assertUsableApproval(approval, request);
      approval.status = "consumed";
    }

    try {
      const output = await tool.execute(request.input);
      this.captureBudget(run, {
        toolCalls: 1,
        tokens: estimate.tokens,
        costCents: estimate.costCents,
      });
      const receipt = this.appendReceipt(run.id, "tool.executed", {
        tool: tool.name,
        idempotencyKey: request.idempotencyKey,
        inputHash: hash(request.input),
        outputHash: hash(output),
        estimate,
      });
      const result: ExecutionResult<Output> = {
        status: "executed",
        output,
        receiptId: receipt.id,
        idempotentReplay: false,
      };
      this.executions.set(replayKey, structuredClone(result));
      return result;
    } catch (error) {
      this.appendReceipt(run.id, "tool.failed", {
        tool: tool.name,
        idempotencyKey: request.idempotencyKey,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }

  approve(requestId: string, decidedBy: string): ApprovalRequest {
    const approval = this.requireApproval(requestId);
    if (approval.status !== "pending") {
      throw new GovernanceError("APPROVAL_CLOSED", "Approval is no longer pending");
    }
    if (this.clock().getTime() >= new Date(approval.expiresAt).getTime()) {
      throw new GovernanceError("APPROVAL_EXPIRED", "Approval request has expired");
    }
    approval.status = "approved";
    approval.decidedBy = decidedBy;
    this.appendReceipt(approval.runId, "approval.granted", {
      approvalRequestId: approval.id,
      decidedBy,
    });
    return structuredClone(approval);
  }

  reject(requestId: string, decidedBy: string): ApprovalRequest {
    const approval = this.requireApproval(requestId);
    if (approval.status !== "pending") {
      throw new GovernanceError("APPROVAL_CLOSED", "Approval is no longer pending");
    }
    approval.status = "rejected";
    approval.decidedBy = decidedBy;
    this.appendReceipt(approval.runId, "approval.rejected", {
      approvalRequestId: approval.id,
      decidedBy,
    });
    return structuredClone(approval);
  }

  stageMemory(runId: string, key: string, value: unknown): MemoryCandidate {
    this.assertActive(this.requireRun(runId));
    const candidate: MemoryCandidate = {
      runId,
      key,
      value: structuredClone(value),
      verified: false,
      humanApproved: false,
      promoted: false,
    };
    this.memory.set(`${runId}:${key}`, candidate);
    this.appendReceipt(runId, "memory.staged", { key, valueHash: hash(value) });
    return structuredClone(candidate);
  }

  verifyMemory(runId: string, key: string): MemoryCandidate {
    const candidate = this.requireMemory(runId, key);
    candidate.verified = true;
    this.appendReceipt(runId, "memory.verified", { key });
    return structuredClone(candidate);
  }

  approveMemory(runId: string, key: string, decidedBy: string): MemoryCandidate {
    const candidate = this.requireMemory(runId, key);
    candidate.humanApproved = true;
    this.appendReceipt(runId, "memory.approved", { key, decidedBy });
    return structuredClone(candidate);
  }

  promoteMemory(runId: string, key: string): MemoryCandidate {
    const candidate = this.requireMemory(runId, key);
    if (!candidate.verified || !candidate.humanApproved) {
      throw new GovernanceError(
        "MEMORY_NOT_GOVERNED",
        "Memory must be verified and human-approved before promotion",
      );
    }
    candidate.promoted = true;
    this.appendReceipt(runId, "memory.promoted", { key });
    return structuredClone(candidate);
  }

  getAuditLog(runId: string): AuditReceipt[] {
    this.requireRun(runId);
    return structuredClone(this.receipts.get(runId) ?? []);
  }

  validateAuditChain(runId: string, log = this.getAuditLog(runId)): boolean {
    let previousHash = "GENESIS";
    for (let index = 0; index < log.length; index += 1) {
      const receipt = log[index];
      if (receipt.sequence !== index + 1 || receipt.previousHash !== previousHash) return false;
      const expected = hash({
        id: receipt.id,
        sequence: receipt.sequence,
        runId: receipt.runId,
        event: receipt.event,
        at: receipt.at,
        detailsHash: receipt.detailsHash,
        previousHash: receipt.previousHash,
      });
      if (receipt.receiptHash !== expected) return false;
      previousHash = receipt.receiptHash;
    }
    return true;
  }

  private requireRun(runId: string): RunRecord {
    const run = this.runs.get(runId);
    if (!run) throw new GovernanceError("RUN_NOT_FOUND", `Run not found: ${runId}`);
    return run;
  }

  private assertActive(run: RunRecord): void {
    if (run.status !== "active") {
      throw new GovernanceError("RUN_NOT_ACTIVE", `Run is ${run.status}`);
    }
    if (run.expiresAt && this.clock().getTime() >= new Date(run.expiresAt).getTime()) {
      throw new GovernanceError("RUN_EXPIRED", "Run has expired");
    }
  }

  private assertPinnedSpec(run: RunRecord, suppliedSpecHash: string): void {
    if (run.specHash !== suppliedSpecHash) {
      throw new GovernanceError("SPEC_MISMATCH", "Request does not match the run's pinned specification");
    }
  }

  private assertCapability(run: RunRecord, capability: string, tool: string): void {
    const now = this.clock().getTime();
    const granted = run.grants.some((grant) => {
      const unexpired = !grant.expiresAt || now < new Date(grant.expiresAt).getTime();
      return grant.capability === capability && grant.allowedTools.includes(tool) && unexpired;
    });
    if (!granted) {
      this.appendReceipt(run.id, "tool.denied", { tool, reason: "capability_not_granted" });
      throw new GovernanceError("CAPABILITY_DENIED", `Capability not granted for tool: ${tool}`);
    }
  }

  private assertBudget(run: RunRecord, requested: BudgetUsage): void {
    const next = {
      toolCalls: run.usage.toolCalls + requested.toolCalls,
      tokens: run.usage.tokens + requested.tokens,
      costCents: run.usage.costCents + requested.costCents,
    };
    if (
      next.toolCalls > run.budget.toolCalls ||
      next.tokens > run.budget.tokens ||
      next.costCents > run.budget.costCents
    ) {
      this.appendReceipt(run.id, "tool.denied", { reason: "budget_exceeded", requested, next });
      throw new GovernanceError("BUDGET_EXCEEDED", "Tool call would exceed the run budget");
    }
  }

  private captureBudget(run: RunRecord, used: BudgetUsage): void {
    run.usage.toolCalls += used.toolCalls;
    run.usage.tokens += used.tokens;
    run.usage.costCents += used.costCents;
  }

  private findOrCreateApproval<Input>(request: ToolRequest<Input>, tool: string): ApprovalRequest {
    const existing = [...this.approvals.values()].find(
      (approval) =>
        approval.runId === request.runId &&
        approval.tool === tool &&
        approval.idempotencyKey === request.idempotencyKey &&
        approval.status === "pending",
    );
    if (existing) return existing;

    const requestedAt = this.clock();
    const approval: ApprovalRequest = {
      id: randomUUID(),
      runId: request.runId,
      tool,
      idempotencyKey: request.idempotencyKey,
      reason: `Human approval is required before ${tool} can execute`,
      status: "pending",
      requestedAt: requestedAt.toISOString(),
      expiresAt: new Date(requestedAt.getTime() + 15 * 60_000).toISOString(),
    };
    this.approvals.set(approval.id, approval);
    return approval;
  }

  private requireApproval(requestId: string): ApprovalRequest {
    const approval = this.approvals.get(requestId);
    if (!approval) throw new GovernanceError("APPROVAL_NOT_FOUND", "Approval request was not found");
    return approval;
  }

  private assertUsableApproval<Input>(approval: ApprovalRequest, request: ToolRequest<Input>): void {
    if (
      approval.runId !== request.runId ||
      approval.tool !== request.tool ||
      approval.idempotencyKey !== request.idempotencyKey
    ) {
      throw new GovernanceError("APPROVAL_SCOPE_MISMATCH", "Approval does not match this tool request");
    }
    if (approval.status !== "approved") {
      throw new GovernanceError("APPROVAL_NOT_GRANTED", `Approval is ${approval.status}`);
    }
    if (this.clock().getTime() >= new Date(approval.expiresAt).getTime()) {
      throw new GovernanceError("APPROVAL_EXPIRED", "Approval has expired");
    }
  }

  private requireMemory(runId: string, key: string): MemoryCandidate {
    const candidate = this.memory.get(`${runId}:${key}`);
    if (!candidate) throw new GovernanceError("MEMORY_NOT_FOUND", `Memory not found: ${key}`);
    return candidate;
  }

  private appendReceipt(runId: string, event: string, details: unknown): AuditReceipt {
    const log = this.receipts.get(runId) ?? [];
    const previousHash = log.at(-1)?.receiptHash ?? "GENESIS";
    const base = {
      id: randomUUID(),
      sequence: log.length + 1,
      runId,
      event,
      at: this.now(),
      detailsHash: hash(details),
      previousHash,
    };
    const receipt: AuditReceipt = { ...base, receiptHash: hash(base) };
    log.push(receipt);
    this.receipts.set(runId, log);
    return receipt;
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

function hash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

