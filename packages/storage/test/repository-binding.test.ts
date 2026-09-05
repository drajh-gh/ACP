import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStableId } from "@acp/domain";
import { parseWindowsDirectoryBinding, parseRepositoryBinding, parseWorktreeBinding } from "../src/repository-binding.ts";

const identity = "win32-dir:12345678:0000000000000001";
describe("filesystem observation contracts", () => {
  it("retains exact canonical Unicode path spelling and native identity", () => {
    const value = { path: "C:\\ACP ž\\Project 🚀", identity };
    assert.deepEqual(parseWindowsDirectoryBinding(value), value);
  });
  it("rejects lexical Windows aliases and noncanonical or ambiguous directory paths", () => {
    for (const path of ["C:\\", "C:relative", "relative", "\\\\server\\share", "C:/repo", "C:\\repo/child", "C:\\repo\\..\\child",
      "C:\\repo\\.\\child", "C:\\repo\\\\child", "C:\\repo\\", "C:\\repo.", "C:\\repo ", "C:\\NUL", "C:\\aux.txt",
      "C:\\COM1\\child", "C:\\repo:stream", "C:\\repo?", "C:\\repo\u007f"]) {
      assert.throws(() => parseWindowsDirectoryBinding({ path, identity }), TypeError, path);
    }
    for (const value of [{ path: "C:\\repo", identity: "path-only" }, { path: "C:\\repo", identity, authority: true }]) {
      assert.throws(() => parseWindowsDirectoryBinding(value), TypeError);
    }
  });
  it("requires separate checkout and metadata identities without interpreting a path as a repository ID", () => {
    const base = { repositoryBindingId: createStableId("repositoryBinding"), repositoryId: createStableId("repository"), projectId: createStableId("project"),
      machineFingerprint: "a".repeat(64), checkout: { path: "C:\\repo", identity }, commonGitDirectory: { path: "C:\\repo\\.git", identity: identity.replace(/1$/u, "2") },
      observedAt: "2026-09-05T16:00:00.000Z", provenanceId: createStableId("provenance") };
    assert.deepEqual(parseRepositoryBinding(base), base);
    assert.throws(() => parseRepositoryBinding({ ...base, repositoryId: "https://example.test/repo" }), TypeError);
    assert.throws(() => parseRepositoryBinding({ ...base, commonGitDirectory: { ...base.commonGitDirectory, identity } }), TypeError);
    assert.throws(() => parseRepositoryBinding({ ...base, observedAt: "unknown" }), TypeError);
  });
  it("preserves Git branch case and requires a full observed revision", () => {
    const base = { worktreeBindingId: createStableId("worktreeBinding"), repositoryBindingId: createStableId("repositoryBinding"), missionId: createStableId("mission"),
      workspace: { path: "C:\\worktrees\\task", identity }, gitDirectory: { path: "C:\\repo\\.git\\worktrees\\task", identity: identity.replace(/1$/u, "2") },
      branchRef: "refs/heads/Feature/CaseSensitive", headRevision: "a".repeat(40), observedAt: "2026-09-05T16:00:00.000Z", provenanceId: createStableId("provenance") };
    assert.deepEqual(parseWorktreeBinding(base), base);
    for (const headRevision of ["HEAD", "abc123", "A".repeat(40)]) assert.throws(() => parseWorktreeBinding({ ...base, headRevision }), TypeError);
    assert.throws(() => parseWorktreeBinding({ ...base, branchRef: "refs/heads/" }), TypeError);
  });
});
