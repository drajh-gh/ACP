import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CounterpartMissionPersistence } from "@acp/storage";

import { authorizeBearerHeader, validateConfiguredBearerToken } from "./auth.ts";
import { createCounterpartMcpServer } from "./mcp-server.ts";

const maximumRequestBytes = 1_048_576;

export interface ControlApiServerOptions {
  readonly persistence: CounterpartMissionPersistence;
  readonly bearerToken: string;
  readonly allowedHosts?: readonly string[];
  readonly allowedOrigins?: readonly string[];
  readonly allowedPluginVersions?: readonly string[];
  readonly trustedProxyAddresses?: readonly string[];
  readonly requireForwardedHttps?: boolean;
}

export function createControlApiServer(options: ControlApiServerOptions): Server {
  const bearerToken = validateConfiguredBearerToken(options.bearerToken);
  const allowedHosts = options.allowedHosts?.map((host) => host.toLowerCase());
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const allowedPluginVersions = new Set(
    options.allowedPluginVersions ?? ["0.1.0"],
  );
  const trustedProxyAddresses = new Set(
    options.trustedProxyAddresses?.map((address) => address.toLowerCase()) ?? [],
  );

  return createServer(async (request, response) => {
    try {
      if (request.url === "/healthz") {
        if (request.method !== "GET") {
          writeJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        writeJson(response, 200, { status: "ok", version: "0.1.0" });
        return;
      }
      if (request.url !== "/mcp") {
        writeJson(response, 404, { error: "not_found" });
        return;
      }
      if (!originAllowed(request, allowedOrigins)) {
        writeJson(response, 403, { error: "invalid_origin" });
        return;
      }
      if (!hostAllowed(request, allowedHosts)) {
        writeJson(response, 400, { error: "invalid_host" });
        return;
      }
      if (
        options.requireForwardedHttps === true &&
        !forwardedAsHttps(request, trustedProxyAddresses)
      ) {
        writeJson(response, 400, { error: "https_required" });
        return;
      }
      if (!authorizeBearerHeader(request.headers.authorization, bearerToken)) {
        response.setHeader("WWW-Authenticate", 'Bearer realm="acp-control"');
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (!pluginVersionAllowed(request, allowedPluginVersions)) {
        writeJson(response, 426, { error: "incompatible_plugin_version" });
        return;
      }
      if (!(["POST", "GET", "DELETE"] as const).includes(
        request.method as "POST" | "GET" | "DELETE",
      )) {
        writeJson(response, 405, { error: "method_not_allowed" });
        return;
      }

      const body = request.method === "POST"
        ? await readJsonBody(request, maximumRequestBytes)
        : undefined;
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      const mcp = createCounterpartMcpServer(options.persistence);
      try {
        await mcp.connect(transport as unknown as Transport);
        await transport.handleRequest(request, response, body);
      } finally {
        await mcp.close();
      }
    } catch (error) {
      if (!response.headersSent) {
        const status = error instanceof RequestBodyError ? error.status : 500;
        const code = error instanceof RequestBodyError
          ? error.code
          : "internal_server_error";
        writeJson(response, status, {
          error: code,
        });
      } else if (!response.writableEnded) {
        response.end();
      }
    }
  });
}

function originAllowed(
  request: IncomingMessage,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  return typeof origin === "string" && allowedOrigins.has(origin);
}

function hostAllowed(
  request: IncomingMessage,
  allowedHosts: readonly string[] | undefined,
): boolean {
  if (allowedHosts === undefined) return true;
  const host = request.headers.host?.toLowerCase();
  return host !== undefined && allowedHosts.includes(host);
}

function forwardedAsHttps(
  request: IncomingMessage,
  trustedProxyAddresses: ReadonlySet<string>,
): boolean {
  const remoteAddress = request.socket.remoteAddress?.toLowerCase();
  if (
    remoteAddress === undefined ||
    !trustedProxyAddresses.has(remoteAddress)
  ) {
    return false;
  }
  const value = request.headers["x-forwarded-proto"];
  return typeof value === "string" && value.trim().toLowerCase() === "https";
}

function pluginVersionAllowed(
  request: IncomingMessage,
  allowedPluginVersions: ReadonlySet<string>,
): boolean {
  const version = request.headers["x-acp-plugin-version"];
  return typeof version === "string" && allowedPluginVersions.has(version);
}

async function readJsonBody(
  request: IncomingMessage,
  limit: number,
): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new RequestBodyError(415, "unsupported_media_type");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new RequestBodyError(413, "request_too_large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RequestBodyError(400, "invalid_json");
  }
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
): void {
  const encoded = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Length", Buffer.byteLength(encoded, "utf8"));
  response.end(encoded);
}

class RequestBodyError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
