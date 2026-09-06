# Architecture decisions

Architecture decision records (ADRs) capture choices that constrain ACP's
implementation. They are immutable once superseded: a later decision replaces
an earlier one by adding a new ADR and linking both records.

The M0 baseline is derived from [product specification 1.0.0](../../SPECIFICATION.md)
dated 2026-09-04. The specification is the product authority; these records
explain how its fixed technology choices shape the repository.

| ADR | Decision |
|---|---|
| [0001](0001-typescript-monorepo.md) | TypeScript monorepo |
| [0002](0002-postgresql-operational-state.md) | PostgreSQL operational state |
| [0003](0003-dbos-durable-workflows.md) | DBOS durable workflows |
| [0004](0004-codex-sdk-workers.md) | Codex SDK workers |
| [0005](0005-remote-mcp-plugin.md) | Authenticated remote MCP plugin |
| [0006](0006-deterministic-effect-mediation.md) | Deterministic effect mediation |
| [0007](0007-host-filesystem-bindings.md) | Immutable host filesystem bindings |
| [0008](0008-filesystem-writer-leases.md) | Dedicated filesystem writer exclusion |
| [0009](0009-leased-native-preflight.md) | Lease-bracketed native preflight |
| [0010](0010-cooperative-writer-renewal.md) | Cooperative writer renewal |
| [0011](0011-native-lease-watchdog.md) | Native lease-epoch watchdog |
| [0012](0012-native-writer-controller.md) | Database-bound native writer controller |
| [0013](0013-private-native-lease-channel.md) | Private leased launch and persisted target binding |
| [0014](0014-linked-worktree-identity-pins.md) | Standalone linked-worktree identity pins |
| [0015](0015-pre-run-target-holds.md) | Dispatch-bound pre-run target holds |
| [0016](0016-recorded-counterpart-status.md) | Bounded recorded counterpart mission status |
| [0017](0017-inert-provisioner-plans.md) | Inert immutable provisioner attempt plans |
| [0018](0018-provisioner-target-observation.md) | Standalone native provisioner target observations |
| [0019](0019-recorded-capability-readiness.md) | Exact recorded capability readiness |
| [0020](0020-inert-profile-proposals.md) | Inert whole-profile proposals and exact review requests |
| [0021](0021-retained-profile-proposals.md) | Retained inert profile-proposal history |
| [0022](0022-native-provisioner-fence.md) | Native-only permanent provisioner fencing |
| [0023](0023-inert-provisioner-journal.md) | Inert provisioner process and sealed-stop journal |
| [0024](0024-native-root-claims.md) | Shared recorded Windows root exclusion |
| [0025](0025-fresh-provisioner-admission.md) | Atomic fresh-only provisioner admission |
| [0026](0026-private-provisioner-controller.md) | Private one-shot provisioner controller |
| [0027](0027-native-provisioner-admission.md) | Native one-shot provisioner admission |
| [0028](0028-native-provisioner-bridge.md) | Private native provisioner bridge |
| [0029](0029-private-provisioner-channel.md) | Exact private provisioner channel |
| [0030](0030-owned-provisioner-process-runner.md) | Owned provisioner process runner |
| [0031](0031-stored-plan-provisioner-executor.md) | Stored-plan provisioner executor |
| [0032](0032-provisioner-binding-identity-pins.md) | Original provisioner binding pins |
| [0033](0033-provisioner-bridge-binding-lifetime.md) | Provisioner bridge binding lifetime |
| [0034](0034-counterpart-mission-creation-sessions.md) | Isolated counterpart creation sessions |
| [0035](0035-counterpart-mission-response-boundary.md) | Bounded mission responses and uncertain creation |
| [0036](0036-stopped-provisioner-worktree-observation.md) | Read-only stopped worktree observation |
| [0037](0037-recorded-attention-queue.md) | Recorded attention, distinct from decisions and notifications |
