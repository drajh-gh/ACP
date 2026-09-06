import { createHash } from "node:crypto";
import { expectOnlyKeys, expectRecord, parseStableId, reduceProfileDiscoveryObservations,
  type ProfileDiscoveryObservation, type StableId } from "@acp/domain";

export const npmManifestMaximumBytes = 262_144;
export interface NpmManifestDiscoveryInput {
  readonly evidenceId: StableId<"evidence">;
  readonly expectedContentHash: string;
  readonly bytes: Uint8Array;
}
export type NpmManifestDiscoveryResult =
  | { readonly state: "unconfirmed"; readonly kind: "npm_package_manifest"; readonly observations: readonly [] }
  | { readonly state: "observed"; readonly kind: "npm_package_manifest"; readonly scope: "configured_script_metadata_only";
      readonly evidenceId: StableId<"evidence">; readonly contentHash: string; readonly observations: readonly ProfileDiscoveryObservation[] };
const typedArrayByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")!.get!;
const categories = [["test", "verification.tests"], ["lint", "verification.linting"], ["build", "verification.builds"]] as const;
const hash = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

/** Static extraction only. Supplied bytes/hash/evidence ID do not establish path, project, freshness or source authority. */
export function discoverNpmPackageManifest(value: unknown): NpmManifestDiscoveryResult {
  try {
    const input = expectRecord(value, "npm manifest discovery");
    expectOnlyKeys(input, ["evidenceId", "expectedContentHash", "bytes"], "npm manifest discovery");
    const evidenceId = parseStableId(input.evidenceId, "evidence");
    if (typeof input.expectedContentHash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(input.expectedContentHash)
      || !(input.bytes instanceof Uint8Array)) throw new Error("invalid manifest binding");
    const length = typedArrayByteLength.call(input.bytes) as number;
    if (length < 1 || length > npmManifestMaximumBytes) throw new Error("manifest byte bound");
    // Copy intrinsic typed-array storage, without a caller iterator/species or a later mutable-buffer dependency.
    const bytes = new Uint8Array(length); Uint8Array.prototype.set.call(bytes, input.bytes);
    const contentHash = hash(bytes);
    if (contentHash !== input.expectedContentHash) throw new Error("manifest content changed");
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const manifest = expectRecord(parseBoundedManifestJson(text), "npm package manifest");
    const scripts = Object.hasOwn(manifest, "scripts") ? expectRecord(manifest.scripts, "npm scripts") : {};
    const names = Object.keys(scripts).sort();
    if (names.length > 100) throw new Error("script count bound");
    const commands = new Map<string, string>();
    for (const name of names) {
      if (name.length < 1 || name.length > 200 || name !== name.trim() || /[\p{Cc}\p{Cs}]/u.test(name)) throw new Error("invalid script name");
      const command = scripts[name];
      if (typeof command !== "string" || !command.trim() || Buffer.byteLength(command, "utf8") > 4096
        || /[\p{Cc}\p{Cs}]/u.test(command)) throw new Error("invalid script command");
      commands.set(name, hash(command));
    }
    const observations: ProfileDiscoveryObservation[] = [];
    for (const [prefix, fieldId] of categories) {
      const selected = names.filter(name => name === prefix || (name.startsWith(`${prefix}:`) && name.length > prefix.length + 1));
      if (!selected.length) continue; // Absence here is not absence of a project's tests, linter or build system.
      observations.push({ fieldId, evidenceIds: [evidenceId], value: {
        source: "npm_package_manifest", status: "configured_only", execution: "not_performed", commandBodies: "not_disclosed",
        scripts: selected.map(name => ({ name, commandDigest: commands.get(name)!,
          preCommandDigest: commands.get(`pre${name}`) ?? null, postCommandDigest: commands.get(`post${name}`) ?? null })),
      } });
    }
    // Enforce shared complete-field/fact limits before exposing even a partial successful extraction.
    reduceProfileDiscoveryObservations(observations);
    return { state: "observed", kind: "npm_package_manifest", scope: "configured_script_metadata_only", evidenceId, contentHash, observations };
  } catch { return { state: "unconfirmed", kind: "npm_package_manifest", observations: [] }; }
}

/** Bounded JSON, with duplicate decoded object keys rejected instead of last-value-wins ambiguity. */
function parseBoundedManifestJson(text: string): unknown {
  const stack: { object: boolean; keys: Set<string>; expectsKey: boolean }[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      const start = index++;
      let closed = false;
      while (index < text.length) {
        if (text[index] === "\\") { index += 2; continue; }
        if (text[index++] === '"') { closed = true; break; }
      }
      if (!closed) throw new Error("unterminated manifest string");
      const parent = stack.at(-1);
      if (parent?.object && parent.expectsKey) {
        const key = JSON.parse(text.slice(start, index)) as string;
        if (parent.keys.has(key)) throw new Error("duplicate manifest key");
        parent.keys.add(key); parent.expectsKey = false;
      }
    } else {
      if (char === "{" || char === "[") {
        stack.push({ object: char === "{", keys: new Set(), expectsKey: char === "{" });
        if (stack.length > 32) throw new Error("manifest depth bound");
      } else if (char === "}" || char === "]") stack.pop();
      else if (char === "," && stack.at(-1)?.object) stack.at(-1)!.expectsKey = true;
      index++;
    }
  }
  // Native parsing remains responsible for full grammar, escape and trailing-content validation.
  const root = JSON.parse(text) as unknown, pending: unknown[] = [root];
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (++nodes > 10_000) throw new Error("manifest node bound");
    if (Array.isArray(item)) pending.push(...item);
    else if (item !== null && typeof item === "object") pending.push(...Object.values(item));
  }
  return root;
}
