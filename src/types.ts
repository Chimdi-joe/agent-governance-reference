export type RunStatus = "active" | "completed" | "failed";
export type RiskLevel = "low" | "medium" | "high";

export interface BudgetLimits {
  toolCalls: number;
  tokens: number;
  costCents: number;
}

export interface BudgetUsage {
  toolCalls: number;
  tokens: number;
  costCents: number;
}

export interface CapabilityGrant {
  capability: string;
  allowedTools: string[];
  expiresAt?: string;
}

export interface RunRecord {
  id: string;
  specHash: string;
  status: RunStatus;
  grants: CapabilityGrant[];
  budget: BudgetLimits;
  usage: BudgetUsage;
  createdAt: string;
  expiresAt?: string;
}

export interface ToolEstimate {
  tokens: number;
  costCents: number;
}

export interface ToolDefinition<Input = unknown, Output = unknown> {
  name: string;
  capability: string;
  risk: RiskLevel;
  requiresApproval?: boolean;
  estimate(input: Input): ToolEstimate;
  execute(input: Input): Promise<Output>;
}

export interface ToolRequest<Input = unknown> {
  runId: string;
  specHash: string;
  tool: string;
  input: Input;
  idempotencyKey: string;
  approvalRequestId?: string;
}

export interface ApprovalRequest {
  id: string;
  runId: string;
  tool: string;
  idempotencyKey: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "consumed";
  requestedAt: string;
  expiresAt: string;
  decidedBy?: string;
}

export interface ExecutionResult<Output = unknown> {
  status: "executed";
  output: Output;
  receiptId: string;
  idempotentReplay: boolean;
}

export interface ApprovalRequiredResult {
  status: "approval_required";
  approvalRequestId: string;
  reason: string;
}

export type ToolResult<Output = unknown> =
  | ExecutionResult<Output>
  | ApprovalRequiredResult;

export interface AuditReceipt {
  id: string;
  sequence: number;
  runId: string;
  event: string;
  at: string;
  detailsHash: string;
  previousHash: string;
  receiptHash: string;
}

export interface MemoryCandidate {
  runId: string;
  key: string;
  value: unknown;
  verified: boolean;
  humanApproved: boolean;
  promoted: boolean;
}

