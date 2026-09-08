# Working on ACP

## Source and scope

- Read `docs/implementation/PRODUCT_SLICE.md` for the selected increment and source
  versions, then the relevant sections of `SPECIFICATION.md`,
  `docs/ACP_PRODUCT_SPECIFICATION.md`, and `docs/AIRPORT_UX_UI_SPECIFICATION.md`.
- Documents describe intended behavior; code and exact test evidence establish
  implemented behavior. Proposed policies remain proposed. Use ACP as the name.
- Preserve working-tree changes. Keep task changes bounded and stage exact reviewed
  paths only. Commit, push, merge, deployment and provider effects require user
  authority; a setup script or this file does not supply it.
- Never commit credentials, `.env` files, `.local-private/`, or generated review
  captures. Do not copy the user's Codex home, login state or plugin cache to cloud.

## Execution location and resources

- Prefer a Codex cloud checkout for implementation, compilation and routine tests.
  Cloud setup is documented in `docs/development/CODEX_CLOUD.md`.
- Do not start local WSL, Docker, builds or browser suites merely to emulate cloud.
  Windows-native behavior still requires a separately available Windows gate;
  Linux success is not evidence of Windows process ownership or cleanup.
- Run at most one CPU-intensive command at a time. Keep searches inside the
  smallest relevant directory, with a 60-second limit; exclude dependency trees,
  caches, logs and generated output. Do not scan the user profile or Codex home.
- Bound every test/build command. Record PID and purpose for background processes,
  stop only owned process trees on timeout, and verify their exit. Leave no owned
  services running at handoff. Never disable the Windows Resource Guard.

## Verification

Use the committed lockfile and Node.js 24 in Linux cloud/CI. Setup and maintenance:
`bash scripts/codex-cloud-setup.sh` (180-second dependency-install limit).
Do not install new dependencies or invoke a provider just to prepare this checkout.

Run targeted tests first, then these gates sequentially in Linux cloud:

```bash
timeout --kill-after=10s 120s npm run typecheck
timeout --kill-after=10s 180s npm test
timeout --kill-after=10s 60s npm run check:secrets
git diff --check
```

`npm test` already limits test-file concurrency to one. A targeted TypeScript
test can use `node --experimental-strip-types --test --test-concurrency=1 <path>`
under the same timeout wrapper. Never silently weaken a failing gate.

The default CI gate does not prove live PostgreSQL, DBOS recovery, native Windows
process behavior, browser acceptance, or production readiness. Use the relevant
documented integration gate when its runtime is available; otherwise report it as
not run. Never point a test at a production database or use real credentials.

## Delivery boundaries

Keep original request wording distinct from approved scope. Read projections grant
no approval, execution or closure authority. Missing records are unavailable, not
empty; preserve source pins, timestamps, coverage, conflicts and explicit overflow.
Do not add API-billing fallback, another provider, fixed model routing or recurring
automation without the separately selected policy and authorization.

Report the exact commit, checks, limitations and next step. Local preparation and
GitHub CI success do not prove that a Codex cloud environment is activated.
