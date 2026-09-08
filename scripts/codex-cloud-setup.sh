#!/usr/bin/env bash
# Shared by Codex cloud setup/maintenance and Linux CI. Installs no global tools.
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ACP cloud setup requires a Linux cloud/CI checkout; do not run on the local Windows device." >&2
  exit 1
fi

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
for tool in node npm timeout; do
  command -v "$tool" >/dev/null || { echo "Missing cloud prerequisite: $tool" >&2; exit 1; }
done
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  if (Number(process.versions.node.split(".")[0]) !== 24) {
    throw new Error("Select Node.js 24 in the cloud environment to match ACP CI.");
  }
  if (manifest.name !== "agentic-control-plane" || lock.name !== manifest.name) {
    throw new Error("Expected the ACP repository and its committed lockfile.");
  }
'

echo "ACP cloud dependency setup: shell PID $$; 180-second install limit."
# timeout controls the process group, with a hard stop if graceful termination fails.
timeout --signal=TERM --kill-after=10s 180s \
  npm ci --ignore-scripts --no-audit --no-fund
echo "ACP dependencies ready. No services, migrations, providers or tests were started."
