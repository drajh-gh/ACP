# ACP development in Codex cloud

Purpose: move repository editing and CPU-heavy verification off the operator's
Windows device. This is a development environment, not deployment of ACP's runtime.

## Environment configuration

In the signed-in [Codex environment settings](https://chatgpt.com/codex/settings/environments),
select the existing GitHub repository `drajh-gh/ACP` and branch `main`.
Reuse an ACP environment if one exists; do not create duplicates.

| Setting | Value |
|---|---|
| Image | Default universal Linux image |
| Node.js | 24, matching `.github/workflows/ci.yml` |
| Setup script | `bash scripts/codex-cloud-setup.sh` |
| Maintenance script | `bash scripts/codex-cloud-setup.sh` |
| Agent internet | Off for the initial contract/storage work |
| Environment secrets | None required for this setup |
| Production services / provider keys | None |

Only connect the intended repository. If GitHub authorization is missing, the
account owner must approve the exact repository access. Do not broaden access to
other repositories or copy desktop credentials into the environment.

Setup installs committed dependencies with lifecycle scripts disabled, without
global tools, browser downloads, Docker or database setup. It stops on install
failure or a wrong runtime. Maintenance intentionally repeats the locked install
because a resumed environment may have checked out a different lockfile. It does
not run tests automatically or start a server. Reset the cloud cache if needed;
do not patch a cached dependency to disguise a lockfile mismatch.

OpenAI documents container checkout, setup/maintenance, runtime selection, and
network behavior in [Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environment).
Setup has internet access; agent access is separately configured. Local environment
variables and desktop plugins are not assumed to transfer.

## First cloud verification

After saving the environment, run a small cloud task against the published commit:

> Prepare ACP in this cloud checkout. Read AGENTS.md. Report the repository,
> branch, full HEAD, operating system and Node version. Run typecheck, npm test,
> secret scan and git diff --check sequentially under the documented timeouts.
> Do not change source, install additional tools, invoke providers, start services,
> deploy, or write to GitHub. Report failures and unavailable platform gates
> separately. Confirm the checkout is unchanged afterward.

The environment is verified only after a cloud result shows the expected commit,
Linux/Node 24, setup success and gate results. A green GitHub Actions run proves
the shared Linux setup in CI, not Codex account access or cloud activation.

## Implementation handoff

After the first cloud check, the next selected product increment is the read-only
request brief in `docs/implementation/PRODUCT_SLICE.md`. Start from its current
source pins, retain known records and explicit unavailable fields, and keep
authority and evidence limits intact. The cloud task must read the repository's
current requirements rather than relying on an earlier desktop conversation.

Review cloud changes as a diff/PR before integrating them. Use a `codex/` branch
for new implementation branches. Do not run a concurrent local writer on the same
files. After publication, update the local checkout only after preserving any local
changes; do not force-reset it. Revert a faulty setup commit through ordinary Git
review, or clear the environment's setup/maintenance commands to stop using it.

## Gates that remain distinct

- Default CI: compiler, contract/store tests and common secret-format scan.
- PostgreSQL: `scripts/check-postgres.ps1` uses a disposable Docker fixture and
  bounded phases; not provisioned by this cloud setup. Live database changes need
  their matching integration evidence before readiness can be claimed.
- Windows-native process and recovery checks need Windows; do not mark them passed
  from Linux mocks. Keep them off the operator device unless explicitly scheduled.
- Operations browser checks currently expect an installed Playwright module and
  Microsoft Edge. The setup does not install either or claim visual acceptance.
- No real provider calls, billing fallback, deployment or new subscriptions are
  required. Cloud use still consumes the account's applicable allowance; moving
  compute off-device is not a claim of lower token usage.

Activation status: repository preparation only until the signed-in environment
and first cloud result are observed. No overnight automation is part of this setup.
