import type { Logger } from "./logger.js";
import { runDryRun, runServe, runValidate } from "./serve.js";

type CliCommand = "serve" | "validate" | "dry-run";

type ParsedArgs = {
  command: CliCommand;
  flags: Record<string, string | boolean>;
};

const HELP_TEXT = `umcp - Unified MCP Aggregator

Usage:
  umcp serve [--transport stdio|http] [--host 127.0.0.1] [--port 8787] [--path /mcp] [--config /path/to/umcp.jsonc]
  umcp validate [--config /path/to/umcp.jsonc]
  umcp dry-run [--config /path/to/umcp.jsonc]

Compatibility flags:
  umcp --validate [--config /path/to/umcp.jsonc]
  umcp --dry-run [--config /path/to/umcp.jsonc]
`;

function parseFlags(args: string[]): { positionals: string[]; flags: Record<string, string | boolean> } {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    if (!rawKey) {
      continue;
    }

    if (inlineValue !== undefined) {
      flags[rawKey] = inlineValue;
      continue;
    }

    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      flags[rawKey] = next;
      i += 1;
    } else {
      flags[rawKey] = true;
    }
  }

  return { positionals, flags };
}

function parseCommand(argv: string[]): ParsedArgs {
  const { positionals, flags } = parseFlags(argv);

  if (flags.help || flags.h) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }

  if (flags.validate) {
    return { command: "validate", flags };
  }

  if (flags["dry-run"]) {
    return { command: "dry-run", flags };
  }

  const positionalCommand = positionals[0];
  if (!positionalCommand) {
    return { command: "serve", flags };
  }

  if (positionalCommand === "serve" || positionalCommand === "validate" || positionalCommand === "dry-run") {
    const commandIndex = argv.indexOf(positionalCommand);
    const subArgs = commandIndex >= 0 ? argv.slice(commandIndex + 1) : [];
    const parsed = parseFlags(subArgs);
    return { command: positionalCommand, flags: { ...flags, ...parsed.flags } };
  }

  throw new Error(`Unknown command '${positionalCommand}'. Use --help for usage.`);
}

function getStringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  if (typeof value === "string") {
    return value;
  }
  return undefined;
}

function getPortFlag(flags: Record<string, string | boolean>, key: string, defaultValue: number): number {
  const raw = getStringFlag(flags, key);
  if (!raw) {
    return defaultValue;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for --${key}: ${raw}`);
  }
  return parsed;
}

export async function runCli(argv: string[], logger: Logger): Promise<void> {
  const { command, flags } = parseCommand(argv);
  const configPath = getStringFlag(flags, "config");

  if (command === "validate") {
    await runValidate({ configPath, logger });
    return;
  }

  if (command === "dry-run") {
    await runDryRun({ configPath, logger });
    return;
  }

  const transportFlag = getStringFlag(flags, "transport") ?? "stdio";
  if (transportFlag !== "stdio" && transportFlag !== "http") {
    throw new Error(`Invalid --transport value '${transportFlag}'. Expected 'stdio' or 'http'.`);
  }

  const host = getStringFlag(flags, "host") ?? "127.0.0.1";
  const port = getPortFlag(flags, "port", 8787);
  const path = getStringFlag(flags, "path") ?? "/mcp";

  await runServe({
    configPath,
    transport: transportFlag,
    host,
    port,
    path,
    logger
  });
}
