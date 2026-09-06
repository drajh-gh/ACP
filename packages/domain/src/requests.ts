import { canonicalJsonDigest } from "./effects.ts";
import { parseStableId, type StableId } from "./ids.ts";
import { snapshotJsonData } from "./json-snapshot.ts";
import { expectOnlyKeys, expectRecord } from "./validation.ts";

export const requestIdentitySchemaVersion = "1.0.0";
export const requestIdentityMaximumBytes = 32_768;

/** Original, retained matter identity. Not an approved destination, current
 * proposal, executable plan, lifecycle state or assertion that a report is true. */
export interface RequestRegistration {
  readonly requestId: StableId<"request">;
  readonly projectId: StableId<"project">;
  readonly sourceIntakeId: StableId<"intake">;
  readonly title: string;
  readonly summary: string;
}
/** Recorded association only. A mission remains independently governed; a link
 * cannot inherit grants or imply completion of any request obligation. */
export interface RequestMissionLink {
  readonly requestId: StableId<"request">;
  readonly projectId: StableId<"project">;
  readonly missionId: StableId<"mission">;
  readonly reason: string;
}
export function parseRequestRegistration(value: unknown): RequestRegistration {
  const input = exact(value, ["requestId", "projectId", "sourceIntakeId", "title", "summary"]);
  return Object.freeze({ requestId: parseStableId(input.requestId, "request"), projectId: parseStableId(input.projectId, "project"),
    sourceIntakeId: parseStableId(input.sourceIntakeId, "intake"), title: text(input.title, 240, true), summary: text(input.summary, 4000) });
}
export function parseRequestMissionLink(value: unknown): RequestMissionLink {
  const input = exact(value, ["requestId", "projectId", "missionId", "reason"]);
  return Object.freeze({ requestId: parseStableId(input.requestId, "request"), projectId: parseStableId(input.projectId, "project"),
    missionId: parseStableId(input.missionId, "mission"), reason: text(input.reason, 1000) });
}
/** Unlike intake classification, exact retries do not merge similar requests. */
export function requestRegistrationDigest(value: unknown): string {
  return canonicalJsonDigest(snapshotJsonData(parseRequestRegistration(value), { maximumBytes: requestIdentityMaximumBytes }));
}
export function requestMissionLinkDigest(value: unknown): string {
  return canonicalJsonDigest(snapshotJsonData(parseRequestMissionLink(value), { maximumBytes: requestIdentityMaximumBytes }));
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const input = expectRecord(snapshotJsonData(value, { maximumBytes: requestIdentityMaximumBytes }), "request data");
  expectOnlyKeys(input, keys, "request data");
  if (keys.some(key => !Object.hasOwn(input, key))) throw new TypeError("complete request data required");
  return input;
}
function text(value: unknown, maximum: number, singleLine = false): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maximum
    || (singleLine ? /[\p{Cc}\p{Cs}]/u : /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cs}]/u).test(value)) {
    throw new TypeError("bounded canonical request description required");
  }
  return value;
}
