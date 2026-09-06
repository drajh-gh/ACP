import { parseStableId, type StableId } from "@acp/domain";

import { validateConfiguredBearerToken } from "./auth.ts";

/** Keep authenticated control reads/writes bounded; a status snapshot is never
 * an unbounded query or a reason to exhaust the database pool. */
export const controlApiDatabaseLimits=Object.freeze({ max:4,connectionTimeoutMillis:3000,statement_timeout:5000,lock_timeout:2000 });
export const defaultAllowedPluginVersions = Object.freeze(["0.1.0", "0.2.0", "0.3.0", "0.4.0"]);
/** Advertised control surface version, separate from each returned snapshot schema. */
export const controlApiVersion = "0.4.0";

export interface ControlApiConfig {
  readonly databaseUrl: string;
  readonly bearerToken: string;
  readonly runtimeProvenanceId: StableId<"provenance">;
  readonly hostname: string;
  readonly port: number;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly allowedPluginVersions: readonly string[];
  readonly trustedProxyAddresses: readonly string[];
  readonly requireForwardedHttps: boolean;
}

export function parseControlApiConfig(
  environment: Readonly<Record<string, string | undefined>>,
): ControlApiConfig {
  const databaseUrl = required(environment.ACP_DATABASE_URL, "ACP_DATABASE_URL");
  const protocol = new URL(databaseUrl).protocol;
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new TypeError("ACP_DATABASE_URL must be a PostgreSQL URL");
  }
  const hostname = environment.ACP_CONTROL_HOST?.trim() || "127.0.0.1";
  const port = parsePort(environment.ACP_CONTROL_PORT);
  const allowedHosts = parseAllowedHosts(
    environment.ACP_CONTROL_ALLOWED_HOSTS,
    hostname,
    port,
  );
  const requireForwardedHttps = parseBoolean(
    environment.ACP_REQUIRE_FORWARDED_HTTPS,
    "ACP_REQUIRE_FORWARDED_HTTPS",
    environment.NODE_ENV === "production",
  );
  const trustedProxyAddresses = parseTrustedProxyAddresses(
    environment.ACP_CONTROL_TRUSTED_PROXIES,
    hostname,
  );
  if (requireForwardedHttps && trustedProxyAddresses.length === 0) {
    throw new TypeError(
      "forwarded HTTPS enforcement requires an explicit trusted proxy for non-loopback binding",
    );
  }
  return {
    databaseUrl,
    bearerToken: validateConfiguredBearerToken(
      required(environment.ACP_MCP_BEARER_TOKEN, "ACP_MCP_BEARER_TOKEN"),
    ),
    runtimeProvenanceId: parseStableId(
      required(
        environment.ACP_RUNTIME_PROVENANCE_ID,
        "ACP_RUNTIME_PROVENANCE_ID",
      ),
      "provenance",
    ),
    hostname,
    port,
    allowedHosts,
    allowedOrigins: parseAllowedOrigins(environment.ACP_CONTROL_ALLOWED_ORIGINS),
    allowedPluginVersions: parsePluginVersions(
      environment.ACP_ALLOWED_PLUGIN_VERSIONS,
    ),
    trustedProxyAddresses,
    requireForwardedHttps,
  };
}

function parseAllowedOrigins(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  return uniqueList(value, "ACP_CONTROL_ALLOWED_ORIGINS").map((candidate) => {
    const parsed = new URL(candidate);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.origin !== candidate ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      throw new TypeError(
        "ACP_CONTROL_ALLOWED_ORIGINS entries must be exact HTTP(S) origins",
      );
    }
    return parsed.origin;
  });
}

function parsePluginVersions(value: string | undefined): readonly string[] {
  const versions = value === undefined
    ? defaultAllowedPluginVersions
    : uniqueList(value, "ACP_ALLOWED_PLUGIN_VERSIONS");
  if (versions.some((version) => !/^\d+\.\d+\.\d+$/u.test(version))) {
    throw new TypeError(
      "ACP_ALLOWED_PLUGIN_VERSIONS entries must be semantic versions",
    );
  }
  return versions;
}

function parseTrustedProxyAddresses(
  value: string | undefined,
  hostname: string,
): readonly string[] {
  if (value !== undefined) {
    return uniqueList(value, "ACP_CONTROL_TRUSTED_PROXIES");
  }
  return isLoopbackHost(hostname)
    ? ["127.0.0.1", "::1", "::ffff:127.0.0.1"]
    : [];
}

function uniqueList(value: string, name: string): readonly string[] {
  const values = [
    ...new Set(value.split(",").map((candidate) => candidate.trim()).filter(Boolean)),
  ];
  if (values.length === 0) throw new TypeError(`${name} must not be empty`);
  return values;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 8787;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new TypeError("ACP_CONTROL_PORT must be an integer from 1 to 65535");
  }
  return parsed;
}

function parseAllowedHosts(
  value: string | undefined,
  hostname: string,
  port: number,
): readonly string[] {
  const hosts = value === undefined
    ? [
        `${hostname}:${port}`,
        `127.0.0.1:${port}`,
        `localhost:${port}`,
      ]
    : value.split(",").map((candidate) => candidate.trim());
  const normalized = [...new Set(hosts.filter((candidate) => candidate.length > 0))];
  if (normalized.length === 0) {
    throw new TypeError("ACP_CONTROL_ALLOWED_HOSTS must name at least one host");
  }
  return normalized;
}

function parseBoolean(
  value: string | undefined,
  name: string,
  defaultValue: boolean,
): boolean {
  if (value === undefined) return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TypeError(`${name} must be true or false`);
}
