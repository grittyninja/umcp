import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { z } from "zod";
import type { Logger } from "./logger.js";

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "umcp", "umcp.jsonc");
export const NAMESPACE_SEGMENT_REGEX = /^[a-zA-Z0-9_-]+$/;

const transportKindSchema = z.enum(["stdio", "sse", "streamable-http"]);
const envValueSchema = z.union([z.string(), z.array(z.string().min(1)).min(1)]);
const toolMappingSchema = z
  .object({
    upstream: z.string().min(1, "tools[].upstream is required"),
    alias: z
      .string()
      .min(1)
      .regex(
        NAMESPACE_SEGMENT_REGEX,
        "tools[].alias must match [a-zA-Z0-9_-]+ (no dots/spaces; used as namespace segment)"
      )
      .optional(),
    enabled: z.boolean().default(true)
  })
  .strict();

const providerSchema = z
  .object({
    name: z
      .string()
      .min(1, "provider.name is required")
      .regex(
        NAMESPACE_SEGMENT_REGEX,
        "provider.name must match [a-zA-Z0-9_-]+ (no dots/spaces; used as namespace segment)"
      ),
    transport: transportKindSchema.default("stdio"),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    url: z.string().url().optional(),
    env: z.record(z.string(), envValueSchema).optional(),
    tools: z.array(toolMappingSchema).optional()
  })
  .strict()
  .superRefine((provider, ctx) => {
    if (provider.transport === "stdio" && !provider.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provider.command is required when transport is stdio",
        path: ["command"]
      });
    }

    if ((provider.transport === "sse" || provider.transport === "streamable-http") && !provider.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provider.url is required when transport is sse or streamable-http",
        path: ["url"]
      });
    }
  });

const categorySchema = z
  .object({
    providers: z.array(providerSchema).min(1, "categories.<name>.providers must not be empty")
  })
  .strict()
  .superRefine((category, ctx) => {
    const names = new Set<string>();
    for (let index = 0; index < category.providers.length; index += 1) {
      const provider = category.providers[index];
      if (names.has(provider.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate provider name '${provider.name}' within one category`,
          path: ["providers", index, "name"]
        });
      }
      names.add(provider.name);
    }
  });

const configSchema = z
  .object({
    $schema: z.string().optional(),
    categories: z
      .record(z.string().min(1), categorySchema)
      .refine((categories) => Object.keys(categories).length > 0, "categories must include at least one category")
  })
  .superRefine((value, ctx) => {
    for (const categoryName of Object.keys(value.categories)) {
      if (!NAMESPACE_SEGMENT_REGEX.test(categoryName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["categories", categoryName],
          message:
            "category name must match [a-zA-Z0-9_-]+ (no dots/spaces; used as namespace segment)"
        });
      }
    }
  })
  .strict();

export type TransportKind = z.output<typeof transportKindSchema>;
export type EnvValue = z.output<typeof envValueSchema>;
export type ToolMappingConfig = z.output<typeof toolMappingSchema>;
export type ProviderConfig = z.output<typeof providerSchema>;
export type CategoryConfig = z.output<typeof categorySchema>;
export type UmcpConfig = z.output<typeof configSchema>;

type LoadConfigOptions = {
  configPath?: string;
  logger: Logger;
};

function toFriendlyPath(pathParts: Array<string | number>): string {
  if (pathParts.length === 0) {
    return "root";
  }
  return pathParts
    .map((part) => {
      if (typeof part === "number") {
        return `[${part}]`;
      }
      return part;
    })
    .join(".")
    .replace(".[", "[");
}

function formatJsoncErrors(rawText: string, errors: ParseError[]): string {
  return errors
    .map((error) => {
      const before = rawText.slice(0, error.offset);
      const line = before.split("\n").length;
      const col = error.offset - before.lastIndexOf("\n");
      return `${printParseErrorCode(error.error)} at line ${line}, column ${col}`;
    })
    .join("; ");
}

function validateConfigPath(configPath: string): void {
  if (!configPath.endsWith(".jsonc")) {
    throw new Error("Only JSONC config files are supported. Use a .jsonc file path.");
  }
}

function placeholderConfigTemplate(): string {
  return `{
  // Optional JSON Schema path/URL for editor validation.
  // Example local path:
  // "$schema": "/Users/you/path/to/umcp/umcp.config.schema.json"
  "$schema": "SCHEMA_PATH_OR_URL",

  "categories": {
    // Any category key is allowed (example: web_search, linear, project_mgmt).
    "web_search": {
      "providers": [
        {
          // Provider name becomes the second namespace segment:
          // {category}.{provider}.{tool}
          "name": "brave",

          // transport defaults to "stdio", so this can be omitted for simple setups.
          "transport": "stdio",
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-brave-search"],

          // env values support either a single string or an array.
          // Arrays rotate round-robin per invocation.
          "env": {
            "BRAVE_API_KEY": [
              "BRAVE_API_KEY_1",
              "BRAVE_API_KEY_2",
              "BRAVE_API_KEY_3"
            ]
          },

          // tools is optional. If omitted, umcp auto-discovers every upstream tool.
          // If provided, only enabled mappings are exposed.
          "tools": [
            {
              "upstream": "search",
              "alias": "search",
              "enabled": true
            }
          ]
        },
        {
          "name": "tavily",
          "transport": "stdio",
          "command": "npx",
          "args": ["-y", "tavily-mcp"],
          "env": {
            "TAVILY_API_KEY": "TAVILY_API_KEY"
          }
          // tools omitted -> auto-discover all tavily tools
        }
      ]
    },

    "project_mgmt": {
      "providers": [
        {
          "name": "linear",
          "transport": "streamable-http",
          "url": "https://your-linear-server.example.com/mcp",
          "tools": [
            {
              "upstream": "create_issue",
              "alias": "add_task"
            }
          ]
        }
      ]
    }
  }
}
`;
}

async function ensureConfigExists(configPath: string, logger: Logger): Promise<boolean> {
  try {
    await fs.access(configPath);
    return false;
  } catch {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, placeholderConfigTemplate(), "utf8");
    logger.info("config.created", "Created default umcp JSONC config file", { configPath });
    return true;
  }
}

export async function loadConfig(options: LoadConfigOptions): Promise<{
  configPath: string;
  config: UmcpConfig;
  created: boolean;
}> {
  const logger = options.logger;
  const configPath = path.resolve(options.configPath ?? DEFAULT_CONFIG_PATH);
  validateConfigPath(configPath);

  const created = await ensureConfigExists(configPath, logger);
  const rawText = await fs.readFile(configPath, "utf8");

  const parseErrors: ParseError[] = [];
  const parsed = parse(rawText, parseErrors, { allowTrailingComma: true, disallowComments: false });
  if (parseErrors.length > 0) {
    throw new Error(`Invalid JSONC in ${configPath}: ${formatJsoncErrors(rawText, parseErrors)}`);
  }

  const validation = configSchema.safeParse(parsed);
  if (!validation.success) {
    const details = validation.error.issues
      .map((issue) => `${toFriendlyPath(issue.path as Array<string | number>)}: ${issue.message}`)
      .join("; ");
    logger.error("config.invalid", "Config validation failed", { configPath, details });
    throw new Error(`Config validation failed for ${configPath}: ${details}`);
  }

  logger.info("config.loaded", "Loaded umcp config", {
    configPath,
    categories: Object.keys(validation.data.categories).length,
    created
  });

  return { configPath, config: validation.data, created };
}
