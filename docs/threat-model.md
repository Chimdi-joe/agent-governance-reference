# Threat model

This model treats the language model and all model-produced tool arguments as untrusted input.

## Assets

- Customer and tenant data
- Tool credentials and privileged operations
- Financial and token budgets
- Approved work specifications
- Audit evidence
- Long-term memory

## Trust boundaries

1. **Planner to kernel:** a plan cannot grant itself capabilities.
2. **Kernel to tool:** every call is checked against the run, pinned specification, capability grant, budget and approval policy.
3. **Tool to external system:** side effects require an idempotency key and produce a receipt.
4. **Run to memory:** candidate memory is quarantined until verification and human approval.

## Threats and controls

| Threat | Control in this reference |
|---|---|
| Prompt injection requests an unapproved tool | Default-deny capability grants |
| A plan is changed after approval | Pinned specification hash |
| Runaway loops consume resources | Per-run call, token and cost budgets |
| High-risk side effect executes silently | Scoped, expiring, single-use approval |
| Retry duplicates an external action | Run-scoped idempotency keys |
| Audit history is edited | Hash-chained receipts |
| Unverified model output becomes durable memory | Verification plus human approval gate |
| Expired authority is reused | Run, grant and approval expiry checks |

## Deliberate limitations

This is an educational reference, not a production security boundary. A production implementation should add durable transactional storage, authenticated principals, signed approvals, encrypted secrets, tenant isolation, policy versioning, distributed locking, telemetry, independent audit export, and adversarial evaluation.

