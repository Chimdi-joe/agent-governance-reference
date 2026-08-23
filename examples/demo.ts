import { AgentGovernanceKernel } from "../src/kernel.ts";

const kernel = new AgentGovernanceKernel();
kernel.registerTool({
  name: "customer.notify",
  capability: "customer:write",
  risk: "high",
  requiresApproval: true,
  estimate: () => ({ tokens: 10, costCents: 2 }),
  execute: async ({ message }: { message: string }) => ({ delivered: true, message }),
});

kernel.createRun({
  id: "demo-run",
  specHash: "sha256:demo-spec-v1",
  grants: [{ capability: "customer:write", allowedTools: ["customer.notify"] }],
  budget: { toolCalls: 2, tokens: 50, costCents: 10 },
});

const request = {
  runId: "demo-run",
  specHash: "sha256:demo-spec-v1",
  tool: "customer.notify",
  input: { message: "The governed workflow completed." },
  idempotencyKey: "demo-notification-1",
};

const pending = await kernel.requestTool(request);
if (pending.status !== "approval_required") throw new Error("Expected an approval request");

kernel.approve(pending.approvalRequestId, "human-reviewer");
const result = await kernel.requestTool({ ...request, approvalRequestId: pending.approvalRequestId });

console.log(JSON.stringify({ result, audit: kernel.getAuditLog("demo-run") }, null, 2));

