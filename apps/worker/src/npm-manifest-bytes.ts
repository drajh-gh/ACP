export const npmManifestMaximumBytes = 262_144;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")!.get!;

/** An owned, bounded copy of intrinsic typed-array storage; no caller iterator or species. */
export function copyNpmManifestBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error("invalid manifest bytes");
  const length = typedArrayByteLength.call(value) as number;
  if (length < 1 || length > npmManifestMaximumBytes) throw new Error("manifest byte bound");
  const bytes = new Uint8Array(length); Uint8Array.prototype.set.call(bytes, value);
  return bytes;
}
