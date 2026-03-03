import { createServer, type IncomingMessage } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DEFAULT_CONFIG_PATH, loadConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { createProviderManager } from "./providerManager.js";
import { createRoundRobinEnvPool } from "./roundRobinEnvPool.js";
import { discoverUnifiedTools, formatDryRun, registerUnifiedTools } from "./toolRegistry.js";

type CommonOptions = {
  configPath?: string;
  logger: Logger;
};

export type ServeOptions = CommonOptions & {
  transport: "stdio" | "http";
  host: string;
  port: number;
  path: string;
};

export type ValidateOptions = CommonOptions;
export type DryRunOptions = CommonOptions;

function normalizeEndpointPath(rawPath: string): string {
  return rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  const maxSize = 1_048_576;

  for await (const chunk of req) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(bufferChunk);
    size += bufferChunk.length;

    if (size > maxSize) {
      throw new Error("Request body too large");
    }
  }

  if (chunks.length === 0) {
    return undefined;
  }

  const body = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(body);
}

function waitForShutdownSignal(logger: Logger, includeStdinClose = true): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (reason: string) => {
      if (settled) {
        return;
      }
      settled = true;
      process.off("SIGINT", onSigInt);
      process.off("SIGTERM", onSigTerm);
      if (includeStdinClose) {
        process.stdin.off("close", onStdinClose);
      }
      logger.info("shutdown.signal", "Shutdown signal received", { reason });
      resolve(reason);
    };

    const onSigInt = () => finish("SIGINT");
    const onSigTerm = () => finish("SIGTERM");
    const onStdinClose = () => finish("stdin-close");

    process.on("SIGINT", onSigInt);
    process.on("SIGTERM", onSigTerm);
    if (includeStdinClose) {
      process.stdin.on("close", onStdinClose);
    }
  });
}

function resolveConfigPath(configPath?: string): string {
  return configPath ?? DEFAULT_CONFIG_PATH;
}

export async function runValidate(options: ValidateOptions): Promise<void> {
  const configPath = resolveConfigPath(options.configPath);
  await loadConfig({ configPath, logger: options.logger });
  process.stdout.write(`Config is valid: ${configPath}\n`);
}

export async function runDryRun(options: DryRunOptions): Promise<void> {
  const logger = options.logger;
  const configPath = resolveConfigPath(options.configPath);
  const { config } = await loadConfig({ configPath, logger });
  const envPool = createRoundRobinEnvPool(logger);
  const providerManager = createProviderManager({ config, envPool, logger });

  try {
    const bindings = await discoverUnifiedTools(config, providerManager, logger);
    process.stdout.write(`${formatDryRun(bindings)}\n`);
    logger.info("dry_run.complete", "Dry-run completed", { count: bindings.length });
  } finally {
    await providerManager.close();
  }
}

async function runStdioServe(server: McpServer, logger: Logger): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport as any);
  logger.info("server.started", "umcp started with stdio transport");
  await waitForShutdownSignal(logger, true);
}

async function runHttpServe(
  server: McpServer,
  options: { host: string; port: number; path: string; logger: Logger }
): Promise<void> {
  const { host, port, logger } = options;
  const endpointPath = normalizeEndpointPath(options.path);
  const mcpTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  await server.connect(mcpTransport as any);

  const httpServer = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (requestUrl.pathname !== endpointPath) {
        res.statusCode = 404;
        res.end("Not Found");
        return;
      }

      const method = req.method ?? "GET";
      if (method !== "POST" && method !== "GET" && method !== "DELETE") {
        res.statusCode = 405;
        res.end("Method Not Allowed");
        return;
      }

      if (method === "POST") {
        const parsedBody = await readJsonBody(req);
        await mcpTransport.handleRequest(req, res, parsedBody);
      } else {
        await mcpTransport.handleRequest(req, res);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("server.http_error", "HTTP transport request failed", { message });
      if (!res.headersSent) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: message }));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve());
  });

  logger.info("server.started", "umcp started with streamable-http transport", {
    host,
    port,
    endpointPath
  });

  await waitForShutdownSignal(logger, false);

  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
  });
}

export async function runServe(options: ServeOptions): Promise<void> {
  const logger = options.logger;
  const configPath = resolveConfigPath(options.configPath);
  const { config } = await loadConfig({ configPath, logger });

  const envPool = createRoundRobinEnvPool(logger);
  const providerManager = createProviderManager({ config, envPool, logger });
  const server = new McpServer({
    name: "umcp",
    version: "0.1.0"
  });

  try {
    const bindings = await discoverUnifiedTools(config, providerManager, logger);
    registerUnifiedTools(server, bindings, providerManager, logger);

    if (options.transport === "http") {
      await runHttpServe(server, {
        host: options.host,
        port: options.port,
        path: options.path,
        logger
      });
    } else {
      await runStdioServe(server, logger);
    }
  } finally {
    await providerManager.close();
    await server.close();
  }
}
