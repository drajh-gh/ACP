import { createHash } from "node:crypto";
import { expectOnlyKeys, expectRecord, parseStableId, reduceProfileDiscoveryObservations,
  type ProfileDiscoveryObservation, type StableId } from "@acp/domain";
import { copyNpmManifestBytes,npmManifestMaximumBytes } from "./npm-manifest-bytes.ts";
import { parseBoundedJson } from "./bounded-json.ts";
export { npmManifestMaximumBytes } from "./npm-manifest-bytes.ts";

export interface NpmManifestDiscoveryInput {
  readonly evidenceId: StableId<"evidence">;
  readonly expectedContentHash: string;
  readonly bytes: Uint8Array;
}
export type NpmManifestDiscoveryResult =
  | { readonly state: "unconfirmed"; readonly kind: "npm_package_manifest"; readonly observations: readonly [] }
  | { readonly state: "observed"; readonly kind: "npm_package_manifest"; readonly scope: "configured_script_metadata_only";
      readonly evidenceId: StableId<"evidence">; readonly contentHash: string; readonly observations: readonly ProfileDiscoveryObservation[] };
const categories = [["test", "verification.tests"], ["lint", "verification.linting"], ["build", "verification.builds"]] as const;
const hash = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

/** Static extraction only. Supplied bytes/hash/evidence ID do not establish path, project, freshness or source authority. */
export function discoverNpmPackageManifest(value: unknown): NpmManifestDiscoveryResult {
  try {
    const input = expectRecord(value, "npm manifest discovery");
    expectOnlyKeys(input, ["evidenceId", "expectedContentHash", "bytes"], "npm manifest discovery");
    const evidenceId = parseStableId(input.evidenceId, "evidence");
    if (typeof input.expectedContentHash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(input.expectedContentHash)) throw new Error("invalid manifest binding");
    // Copy intrinsic typed-array storage, without a caller iterator/species or a later mutable-buffer dependency.
    const bytes = copyNpmManifestBytes(input.bytes);
    const contentHash = hash(bytes);
    if (contentHash !== input.expectedContentHash) throw new Error("manifest content changed");
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const manifest = expectRecord(parseBoundedJson(text,{maximumBytes:npmManifestMaximumBytes,maximumDepth:32,maximumNodes:10000}), "npm package manifest");
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
