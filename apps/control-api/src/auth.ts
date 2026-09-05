import { createHash, timingSafeEqual } from "node:crypto";

const minimumBearerTokenBytes = 32;

export function validateConfiguredBearerToken(token: string): string {
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new TypeError("ACP_MCP_BEARER_TOKEN is required");
  }
  if (token !== token.trim() || /\s/u.test(token)) {
    throw new TypeError("ACP_MCP_BEARER_TOKEN must not contain whitespace");
  }
  if (Buffer.byteLength(token, "utf8") < minimumBearerTokenBytes) {
    throw new TypeError(
      `ACP_MCP_BEARER_TOKEN must contain at least ${minimumBearerTokenBytes} bytes`,
    );
  }
  return token;
}

export function authorizeBearerHeader(
  authorization: string | readonly string[] | undefined,
  expectedToken: string,
): boolean {
  if (typeof authorization !== "string") return false;
  const match = /^Bearer ([^\s]+)$/u.exec(authorization);
  if (match?.[1] === undefined) return false;
  return timingSafeEqual(digest(match[1]), digest(expectedToken));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
