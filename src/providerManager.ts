import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ProviderConfig, UmcpConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { createRoundRobinEnvPool } from "./roundRobinEnvPool.js";

type RoundRobinEnvPool = ReturnType<typeof createRoundRobinEnvPool>;

type ProviderTransportKind = ProviderConfig["transport"];

export type ProviderRef = {
  category: string;
  provider: ProviderConfig;
  providerId: string;
};

export type UpstreamTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
};

type UpstreamCallResult = {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
};

type ProviderManagerOptions = {
  config: UmcpConfig;
  logger: Logger;
  envPool: RoundRobinEnvPool;
};

type TransportFactory = (provider: ProviderConfig, envValues: Record<string, string>) => unknown;

function isNpmLikeCommand(command: string): boolean {
  const commandName = basename(command).toLowerCase();
  return commandName === "npm" || commandName === "npx";
}

export function withDefaultNpmCache(
  command: string,
  env: Record<string, string>
): { env: Record<string, string>; applied: boolean; cacheDir?: string } {
  if (!isNpmLikeCommand(command)) {
    return { env, applied: false };
  }

  if (env.NPM_CONFIG_CACHE || env.npm_config_cache) {
    return { env, applied: false };
  }

  const cacheDir = join(homedir(), ".cache", "umcp", "npm");
  try {
    mkdirSync(cacheDir, { recursive: true });
  } catch {
    // If directory creation fails, still pass the env var and let npm report if needed.
  }

  return {
    env: {
      ...env,
      NPM_CONFIG_CACHE: cacheDir,
      npm_config_cache: cacheDir
    },
    applied: true,
    cacheDir
  };
}

const transportFactories: Record<ProviderTransportKind, TransportFactory> = {
  stdio: (provider, envValues) => {
    if (!provider.command) {
      throw new Error(`Missing 'command' for stdio provider '${provider.name}'`);
    }

    const inheritedEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") {
        inheritedEnv[key] = value;
      }
    }

    const npmCacheResolved = withDefaultNpmCache(provider.command, {
      ...inheritedEnv,
      ...envValues
    });

    return new StdioClientTransport({
      command: provider.command,
      args: provider.args ?? [],
      env: npmCacheResolved.env
    });
  },
  sse: (provider) => {
    if (!provider.url) {
      throw new Error(`Missing 'url' for sse provider '${provider.name}'`);
    }
    return new SSEClientTransport(new URL(provider.url));
  },
  "streamable-http": (provider) => {
    if (!provider.url) {
      throw new Error(`Missing 'url' for streamable-http provider '${provider.name}'`);
    }
    return new StreamableHTTPClientTransport(new URL(provider.url));
  }
};

function buildProviderRefs(config: UmcpConfig): Map<string, ProviderRef> {
  const refs = new Map<string, ProviderRef>();
  for (const [category, categoryConfig] of Object.entries(config.categories)) {
    for (const provider of categoryConfig.providers) {
      const providerId = `${category}.${provider.name}`;
      refs.set(providerId, { category, provider, providerId });
    }
  }
  return refs;
}

async function closeClient(client: Client): Promise<void> {
  try {
    await client.close();
  } catch {
    // no-op
  }
}

async function listToolsPaged(client: Client): Promise<UpstreamTool[]> {
  const allTools: UpstreamTool[] = [];
  let cursor: string | undefined;

  while (true) {
    const response = await client.listTools(cursor ? { cursor } : {});
    allTools.push(...((response.tools as UpstreamTool[] | undefined) ?? []));
    cursor = typeof response.nextCursor === "string" ? response.nextCursor : undefined;
    if (!cursor) {
      break;
    }
  }

  return allTools;
}

export function createProviderManager(options: ProviderManagerOptions) {
  const { logger, envPool } = options;
  const providerRefs = buildProviderRefs(options.config);

  const persistentClients = new Map<string, Client>();
  const pendingClients = new Map<string, Promise<Client>>();

  async function connectClient(providerRef: ProviderRef, envValues: Record<string, string>): Promise<Client> {
    const client = new Client({
      name: `umcp-upstream-${providerRef.providerId}`,
      version: "0.1.0"
    });
    const transport = transportFactories[providerRef.provider.transport](providerRef.provider, envValues);
    await client.connect(transport as any);

    logger.info("provider.connected", "Connected to upstream provider", {
      providerId: providerRef.providerId,
      transport: providerRef.provider.transport
    });

    return client;
  }

  async function getPersistentClient(providerId: string): Promise<Client> {
    const existing = persistentClients.get(providerId);
    if (existing) {
      return existing;
    }

    const pending = pendingClients.get(providerId);
    if (pending) {
      return pending;
    }

    const providerRef = getProviderRef(providerId);
    const envValues = envPool.discoveryValues(providerRef.provider.env);

    const promise = connectClient(providerRef, envValues)
      .then((client) => {
        persistentClients.set(providerId, client);
        pendingClients.delete(providerId);
        return client;
      })
      .catch((error) => {
        pendingClients.delete(providerId);
        throw error;
      });

    pendingClients.set(providerId, promise);
    return promise;
  }

  async function withEphemeralClient<T>(
    providerRef: ProviderRef,
    envValues: Record<string, string>,
    callback: (client: Client) => Promise<T>
  ): Promise<T> {
    const client = await connectClient(providerRef, envValues);
    try {
      return await callback(client);
    } finally {
      await closeClient(client);
      logger.info("provider.disconnected", "Disconnected ephemeral upstream client", {
        providerId: providerRef.providerId
      });
    }
  }

  function getProviderRef(providerId: string): ProviderRef {
    const providerRef = providerRefs.get(providerId);
    if (!providerRef) {
      throw new Error(`Unknown providerId '${providerId}'`);
    }
    return providerRef;
  }

  function shouldUseEphemeralClient(providerRef: ProviderRef): boolean {
    return envPool.hasRotatingEnv(providerRef.provider.env);
  }

  async function listTools(providerId: string): Promise<UpstreamTool[]> {
    const providerRef = getProviderRef(providerId);
    try {
      if (shouldUseEphemeralClient(providerRef)) {
        const envValues = envPool.discoveryValues(providerRef.provider.env);
        return await withEphemeralClient(providerRef, envValues, (client) => listToolsPaged(client));
      }

      const client = await getPersistentClient(providerId);
      return await listToolsPaged(client);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to list tools for '${providerId}': ${message}`);
    }
  }

  async function callTool(
    providerId: string,
    upstreamToolName: string,
    args: Record<string, unknown>
  ): Promise<UpstreamCallResult> {
    const providerRef = getProviderRef(providerId);

    try {
      if (shouldUseEphemeralClient(providerRef)) {
        const envValues = envPool.next(providerId, providerRef.provider.env);
        return await withEphemeralClient(providerRef, envValues, async (client) => {
          const result = await client.callTool({
            name: upstreamToolName,
            arguments: args
          });
          return result as UpstreamCallResult;
        });
      }

      const client = await getPersistentClient(providerId);
      const result = await client.callTool({
        name: upstreamToolName,
        arguments: args
      });
      return result as UpstreamCallResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Tool call failed for '${providerId}.${upstreamToolName}': ${message}`);
    }
  }

  async function close(): Promise<void> {
    const closing = Array.from(persistentClients.entries()).map(async ([providerId, client]) => {
      await closeClient(client);
      logger.info("provider.disconnected", "Closed persistent upstream client", { providerId });
    });
    await Promise.all(closing);
    persistentClients.clear();
  }

  return {
    getProviderRefs: () => Array.from(providerRefs.values()),
    listTools,
    callTool,
    close
  };
}

export type ProviderManager = ReturnType<typeof createProviderManager>;
