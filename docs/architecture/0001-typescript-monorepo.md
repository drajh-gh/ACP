# ADR 0001: Use a TypeScript monorepo

- Status: Accepted
- Date: 2026-09-04
- Specification: 1.0.0, sections 1 and 30

## Context

ACP has separately deployable services, shared provider-neutral contracts, an
installable Codex plugin, integrations, infrastructure, and test support. Their
version boundaries must remain visible while common types stay consistent.

## Decision

Use one npm-workspaces repository. Deployable surfaces live under `apps/`,
shared contracts and capabilities live under `packages/`, and provider SDK
types stop at adapter boundaries. Packages use ECMAScript modules and strict
TypeScript settings.

M0 uses Node's built-in TypeScript execution for dependency-free domain tests.
A compiler and other development dependencies will be pinned only when their
adoption is explicitly authorized; the checked-in `tsconfig.base.json` already
defines the intended strictness contract.

## Consequences

- Cross-package changes can be tested atomically.
- Package ownership and dependency direction are reviewable.
- Shared packages must not become a miscellaneous dumping ground.
- Native type stripping executes erasable TypeScript but does not replace a
  future compiler-based type-check gate.
