import { lstat, readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

const repositoryRoot = resolve(process.cwd());
const excludedDirectories = new Set([".git", "coverage", "dist", "node_modules"]);
const maximumFileBytes = 1_000_000;

const rules = [
  {
    name: "private key",
    pattern: /-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----/g,
  },
  {
    name: "OpenAI API key",
    pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    name: "GitHub token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  },
  {
    name: "Slack token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    name: "AWS access key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
];

async function* filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    const path = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) {
        yield* filesUnder(path);
      }
      continue;
    }

    if (entry.isFile()) {
      yield path;
    }
  }
}

const findings = [];

for await (const path of filesUnder(repositoryRoot)) {
  const metadata = await lstat(path);
  if (metadata.size > maximumFileBytes) {
    continue;
  }

  const content = await readFile(path);
  if (content.includes(0)) {
    continue;
  }

  const text = content.toString("utf8");
  const lines = text.split(/\r?\n/u);

  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      const beforeMatch = text.slice(0, match.index);
      const line = beforeMatch.split(/\r?\n/u).length;
      if (lines[line - 1]?.includes("secret-scan: allow")) {
        continue;
      }

      findings.push({
        path: relative(repositoryRoot, path),
        line,
        rule: rule.name,
      });
    }
  }
}

if (findings.length > 0) {
  console.error("Potential secrets detected:");
  for (const finding of findings) {
    console.error(`- ${finding.path}:${finding.line} (${finding.rule})`);
  }
  process.exitCode = 1;
} else {
  console.log("Secret scan passed.");
}
