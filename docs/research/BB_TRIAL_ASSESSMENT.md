# BB trial assessment

Date: 2026-09-08. Status: researched and locally inventoried; not installed or exercised.

Recommendation: try BB as a common working interface, beginning with Codex and a
synthetic scratch repository. Add Claude and Cursor sequentially after the first
session passes. This is an operator-tool experiment, not a fourth ACP specification
or adoption of a new execution runtime.

## Readiness on David's machine

| Prerequisite | Read-only observation |
|---|---|
| WSL2 | Installed; only the running `docker-desktop` distribution |
| Normal Ubuntu distribution | Absent |
| Native Windows Node / npm | 25.8.1 / 11.11.0 |
| Native Windows Git | 2.55.0.windows.3 |
| Native Codex CLI | Present in Codex desktop's Windows binary directory |
| Native Claude / Cursor agent CLI | Not found on PATH; this does not prove they are absent elsewhere |
| User `.wslconfig` | Absent |

BB supports Windows through WSL2, with BB, Node, Git and provider CLIs in the same
Linux distribution. Native PowerShell/CMD execution is unsupported. A repository
inside Linux's filesystem avoids the mounted Windows path's slower I/O and weaker
file watching. Native CLI installations and login state do not establish Linux
readiness. See [BB platform support at the selected package commit](https://github.com/get-bb/bb/blob/a4aa07f9ee3fdeb5716a26a368246ea1ef9e0b78/docs/platform-support.md).

Use a dedicated Ubuntu distro, not Docker Desktop's managed distro. Do not start
with the existing ACP Windows checkout. A separate Linux host is an alternative
if local setup or a Docker interruption is inconvenient; its access and resources
would need their own inventory.

## Pinned first trial

The npm registry reported `bb-app@0.42.1` as latest during this investigation, with
package git head `a4aa07f9ee3fdeb5716a26a368246ea1ef9e0b78`. Its Node range is
`^22.19.0 || ^24.0.0 || ^26.0.0`; select Linux Node 24 LTS for this trial. The
existing native Node 25 is outside that range. Pin the package instead of allowing
a changing latest or nightly build. Sources: [published package metadata](https://registry.npmjs.org/bb-app/0.42.1)
and [package guide](https://github.com/get-bb/bb/blob/a4aa07f9ee3fdeb5716a26a368246ea1ef9e0b78/packages/bb-app/README.md).

The following is a preparation/run guide; none of these setup commands was executed
during the investigation.

1. Install a normal Ubuntu WSL2 distro and create its Linux user. Microsoft's
   documented Windows command is `wsl --install -d Ubuntu`. Follow its prompts and
   verify the resulting distribution before installing tools. See [WSL installation](https://learn.microsoft.com/en-us/windows/wsl/install).
2. Establish resource limits before running agents. A four-processor ceiling is
   consistent with the local responsiveness policy. Choose memory after checking
   total RAM and Docker's needs. WSL2 limits in `.wslconfig` apply across distros;
   applying changes may require a WSL shutdown that interrupts Docker Desktop.
   Schedule that interruption rather than silently stopping it. See [Microsoft's WSL settings](https://learn.microsoft.com/en-us/windows/wsl/wsl-config).
3. Install Linux Node 24, Git and the official Codex CLI inside Ubuntu. Authenticate
   with `codex login`, selecting the existing ChatGPT subscription. Confirm the
   account before a model request. API-key login has separate billing. See
   [Codex authentication](https://learn.chatgpt.com/docs/auth).
4. Create a new Linux scratch repository such as `~/work/bb-trial` with synthetic
   files. It needs no production credentials, private project data or Git remote.
5. Start BB in Ubuntu with its own trial data directory:

   ```bash
   BB_TELEMETRY=false npx bb-app@0.42.1 \
     --data-dir "$HOME/.bb-acp-trial" \
     --server-bind-host 127.0.0.1
   ```

   Open `http://localhost:38886` in the Windows browser. If a future npm version
   requires explicit native install-script allowances, follow the pinned package
   guide; do not disable install protections globally.
6. Before the first task, set global concurrency to **1** and choose a machine
   permission ceiling below Full Access in Settings → Machines. Verify the effective
   provider permission mode. The default ceiling is `full`, and concurrency defaults
   are unsuitable for this bounded trial. Keep helper inference on the intended
   Codex credential route, leave API credentials unconfigured, and use text only.
   See [BB configuration](https://github.com/get-bb/bb/blob/a4aa07f9ee3fdeb5716a26a368246ea1ef9e0b78/docs/configuration.md).
7. Run the small checks below with Codex. Then install/authenticate Claude Code and
   Cursor's agent CLI through their official flows, and repeat sequentially.

No BB source build or new provider subscription is needed for this proposed trial.
Record the launcher PID and purpose while it runs, as required by the local policy.

## Subscription routes and account checks

Account-specific subscription details are omitted from this public guide. The
routes below are alternatives to verify, not assertions about the operator's plans.

| Plan | Route to test in BB | What must be verified |
|---|---|---|
| Codex / ChatGPT subscription | Linux Codex CLI with ChatGPT login | Correct subscription identity; no API-key fallback |
| Claude subscription | Linux Claude Code with subscription login | `/status` shows the intended account and subscription authentication |
| Cursor subscription | Linux Cursor agent CLI with `agent login`, through BB's Cursor ACP provider | Correct account/team, adapter discovery and provider usage |

Current Claude Team documentation includes Claude Code with every seat; Premium
seats have greater allowance, and optional usage credits may permit additional
spending. Do not infer the user's seat type or spending settings. See
[Claude Team entitlement](https://support.claude.com/en/articles/11845131-use-claude-code-with-your-team-or-enterprise-plan).

Claude's API/cloud environment configuration and `apiKeyHelper` can override the
subscription route, especially for non-interactive execution. Check whether such
overrides exist without printing credential values, and verify `/status`.
[Claude authentication](https://code.claude.com/docs/en/authentication).
BB's bridge uses the Agent SDK and an installed Claude Code executable; sign-in
must remain through Anthropic's own flow. This does not justify collecting or
proxying subscription tokens. See the [pinned BB bridge](https://github.com/get-bb/bb/blob/a4aa07f9ee3fdeb5716a26a368246ea1ef9e0b78/plugins/provider-claude-code/src/bridge/sdk-session.ts)
and [Anthropic's integration policy](https://code.claude.com/docs/en/legal-and-compliance).

Cursor supports `agent acp`. BB calls its provider `acp-cursor` and documents
`cursor-agent`; verify the installed command and adapter discovery rather than
assuming they match. Here ACP means Agent Client Protocol, distinct from this
project's Agentic Control Plane. See [Cursor ACP](https://cursor.com/docs/cli/acp)
and [Cursor CLI installation](https://cursor.com/docs/cli/installation).

The working interface can be shared; provider allowances remain separate. Keep
the current subscriptions during the trial and compare each provider's own usage
view. Missing BB usage data is unknown, not free execution.

## Trial checks and remaining research

All results below are **not yet tested**.

| Check | Passing observation |
|---|---|
| First read | Codex explains a synthetic README from one BB task using the intended account |
| Small edit | One requested sentence change is visible in the diff and can be reviewed/reverted |
| Permission boundary | The configured boundary is visible and a disallowed action is denied or requests permission as configured |
| Cancellation | A task can be stopped and its owned processes exit |
| Refresh/restart | The request remains understandable; resumption does not duplicate an edit |
| Three providers | Codex, Claude and Cursor each answer sequentially in BB using the intended account |
| Attention benefit | Record app switches and time to recover the next action, compared with the current workflow |
| Resource use | The machine stays responsive with one task and one heavy command at a time |
| Billing | Provider account views show the intended billing route, with unexplained usage investigated |

Codex desktop tools, connected apps, automations, Windows paths and installed Poppy
plugins are **not proven portable**. BB's Codex adapter alone does not establish
parity. Test the specific MCP tools and selected skills needed for real work;
do not copy the entire native Codex home into WSL. Likewise, compare instructions,
context and permissions before trusting a provider handoff. BB session persistence
does not establish ACP's durable approval, effect reconciliation or closure rules.
Linux success also does not validate ACP's Windows-specific process behavior.

## Stop and removal

Stop the foreground launcher with `Ctrl+C`, or use another Ubuntu terminal:

```bash
npx bb-app@0.42.1 stop --data-dir "$HOME/.bb-acp-trial"
```

BB validates its recorded launcher identity before stopping it. Verify the owned
processes exited and the local endpoint stopped responding. Preserve the trial
directory until useful notes are exported; later removal must target only its
verified path. This `npx` approach creates no global BB installation. Provider
logins, npm caches and the Ubuntu distro have separate lifecycles. See
[BB stop behavior](https://github.com/get-bb/bb/blob/a4aa07f9ee3fdeb5716a26a368246ea1ef9e0b78/docs/configuration.md#stopping-a-running-bb).

Keep the API on loopback: the direct server is unauthenticated and exposes file
and command operations. Remote use needs a separately configured supported access
path, such as BB's paired connection or private Tailscale Serve. See
[BB multi-device guidance](https://github.com/get-bb/bb/blob/a4aa07f9ee3fdeb5716a26a368246ea1ef9e0b78/docs/multiple-devices.md).

## Relationship to the ACP build

The [delivery slice](../implementation/PRODUCT_SLICE.md) proposes a bounded,
read-only request brief next. It can proceed independently of BB. Adopt BB for daily
work only after the trial establishes account, permission, recovery and essential
tool compatibility. Any proposal to make BB an ACP runtime dependency needs a
separate architecture decision and comparison against the existing durable runtime.
