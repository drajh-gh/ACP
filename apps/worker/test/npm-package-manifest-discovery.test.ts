import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { createStableId, reduceProfileDiscoveryObservations } from "@acp/domain";
import { discoverNpmPackageManifest } from "../src/npm-package-manifest-discovery.ts";

const evidenceId = createStableId("evidence");
const hash = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const input = (manifest: unknown) => raw(JSON.stringify(manifest));
function raw(text: string) { const bytes = Buffer.from(text, "utf8"); return { evidenceId, expectedContentHash: hash(bytes), bytes }; }
const denied = { state: "unconfirmed", kind: "npm_package_manifest", observations: [] };

it("npm manifest discovery binds exact bytes and extracts only configured script metadata", () => {
  const result = discoverNpmPackageManifest(input({ name: "not-an-acp-project", scripts: {
    "test:unit": "node unit.js", test: "node test.js", pretest: "node setup.js", posttest: "node cleanup.js",
    lint: "node lint.js", build: "node build.js", deploy: "synthetic-private-command",
  }, repository: "synthetic-private-repository", engines: { node: ">=24" } }));
  assert.equal(result.state, "observed"); if (result.state !== "observed") return;
  assert.equal(result.evidenceId, evidenceId); assert.equal(result.scope, "configured_script_metadata_only");
  assert.deepEqual(result.observations.map(item => item.fieldId), ["verification.tests", "verification.linting", "verification.builds"]);
  assert.deepEqual(result.observations[0], { fieldId: "verification.tests", evidenceIds: [evidenceId], value: {
    source: "npm_package_manifest", status: "configured_only", execution: "not_performed", commandBodies: "not_disclosed",
    scripts: [
      { name: "test", commandDigest: hash("node test.js"), preCommandDigest: hash("node setup.js"), postCommandDigest: hash("node cleanup.js") },
      { name: "test:unit", commandDigest: hash("node unit.js"), preCommandDigest: null, postCommandDigest: null },
    ],
  } });
  const fields = reduceProfileDiscoveryObservations(result.observations);
  assert.equal(fields["verification.tests"].status, "observed");
  for (const id of ["verification.requiredGates", "verification.ci", "repositories.inventory", "identity.project", "execution.hostRequirements", "deployment.productionAuthority"] as const) assert.equal(fields[id].status, "missing");
  const encoded = JSON.stringify(result);
  for (const privateText of ["synthetic-private", "node test.js", "node setup.js", "not-an-acp-project", ">=24"]) assert.equal(encoded.includes(privateText), false);
});
it("npm discovery preserves absent categories as unknown and does not mistake hooks or incidental names for tests", () => {
  for (const manifest of [{}, { scripts: {} }, { scripts: { pretest: "a", posttest: "b", contest: "c", rebuild: "d", "test:": "e", Test: "f" } }]) {
    const result = discoverNpmPackageManifest(input(manifest)); assert.equal(result.state, "observed");
    assert.deepEqual(result.observations, []);
    assert.ok(Object.values(reduceProfileDiscoveryObservations(result.observations)).every(field => field.status === "missing"));
  }
});
it("npm discovery treats command bodies and expansion syntax only as undisclosed fingerprinted data", () => {
  const command = 'node -e "throw Error(\'synthetic-never-execute\')" && echo $ACP_MCP_BEARER_TOKEN %ACP_DATABASE_URL%';
  const result = discoverNpmPackageManifest(input({ scripts: { test: command } }));
  assert.equal(result.state, "observed"); assert.equal(JSON.stringify(result).includes("synthetic-never-execute"), false);
  assert.equal(JSON.stringify(result).includes("ACP_MCP_BEARER_TOKEN"), false); assert.equal(JSON.stringify(result).includes(hash(command)), true);
});
it("npm discovery is semantic-order deterministic while retaining source-byte identity", () => {
  const a = discoverNpmPackageManifest(input({ scripts: { "test:z": "z", test: "a", "test:a": "b" }, description: "first" }));
  const b = discoverNpmPackageManifest(input({ description: "second", scripts: { "test:a": "b", test: "a", "test:z": "z" } }));
  assert.equal(a.state, "observed"); assert.equal(b.state, "observed");
  if (a.state !== "observed" || b.state !== "observed") return;
  assert.deepEqual(a.observations, b.observations); assert.notEqual(a.contentHash, b.contentHash);
  assert.deepEqual(reduceProfileDiscoveryObservations([...a.observations, ...b.observations]), reduceProfileDiscoveryObservations(a.observations));
});
it("npm discovery rejects ambiguous duplicate keys including escaped aliases instead of selecting a winner", () => {
  for (const text of ['{"scripts":{"test":"a","test":"b"}}', '{"scripts":{"test":"a"},"scripts":{"test":"b"}}',
    '{"scripts":{"test":"a","te\\u0073t":"b"}}', '{"scripts":{"test":"a"},"unrelated":{"x":1,"x":2}}']) assert.deepEqual(discoverNpmPackageManifest(raw(text)), denied);
});
it("npm discovery rejects hash, encoding, grammar, shape and scope failures without partial output", () => {
  const good = input({ scripts: { test: "synthetic-private" } });
  for (const invalid of [null, {}, { ...good, expectedContentHash: hash("wrong") }, { ...good, expectedContentHash: good.expectedContentHash.toUpperCase() },
    { ...good, evidenceId: createStableId("mission") }, { ...good, confirm: true }, { ...good, projectId: createStableId("project") },
    { ...good, bytes: [...good.bytes] }, { ...good, bytes: new Uint8Array([0xc3, 0x28]), expectedContentHash: hash(new Uint8Array([0xc3, 0x28])) },
    raw("null"), raw("[]"), raw("{"), raw('{"scripts":{"test":"valid",}}'),
    input({ scripts: [] }), input({ scripts: null }), input({ scripts: { test: 5 } }), input({ scripts: { test: "good", unrelated: {} } }),
    input({ scripts: { test: "good", "\u0000": "bad" } }), input({ scripts: { test: "\ud800" } }), input({ scripts: { test: "" } })]) assert.deepEqual(discoverNpmPackageManifest(invalid), denied);
});
it("npm discovery rejects input, parser and reduced-fact overflow instead of truncating declarations", () => {
  for (const value of [input({ ignored: "x".repeat(262144) }), input({ scripts: { test: "x".repeat(4097) } }),
    input({ scripts: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`script${index}`, "a"])) }),
    input({ scripts: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`test:${index}`, "a"])) }),
    raw('{"scripts":{"test":"a"},"deep":' + "[".repeat(33) + "null" + "]".repeat(33) + "}"),
    input({ ignored: Array.from({ length: 10001 }, () => null), scripts: { test: "a" } })]) assert.deepEqual(discoverNpmPackageManifest(value), denied);
});

it("npm discovery hashes only the supplied byte view and does not trust caller iterators or shadowed lengths", () => {
  const good = input({ scripts: { test: "synthetic" } }), container = Buffer.concat([Buffer.from("prefix"), good.bytes, Buffer.from("suffix")]);
  const view = new Uint8Array(container.buffer, container.byteOffset + 6, good.bytes.length);
  let iteratorCalls = 0;
  Object.defineProperty(view, Symbol.iterator, { value: function* () { iteratorCalls++; yield 0; } });
  Object.defineProperty(view, "byteLength", { value: 1 });
  const result = discoverNpmPackageManifest({ ...good, bytes: view });
  assert.equal(result.state, "observed"); assert.equal(iteratorCalls, 0);
  view.fill(0);
  if (result.state === "observed") { assert.equal(result.contentHash, good.expectedContentHash); assert.equal(result.observations.length, 1); }
  const oversized = new Uint8Array(262145); Object.defineProperty(oversized, "byteLength", { value: 1 });
  assert.deepEqual(discoverNpmPackageManifest({ ...good, bytes: oversized }), denied);
});
