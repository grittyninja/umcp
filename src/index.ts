#!/usr/bin/env node

import { runCli } from "./cli.js";
import { createLogger } from "./logger.js";

const logger = createLogger((process.env.UMCP_LOG_LEVEL as "debug" | "info" | "warn" | "error" | undefined) ?? "info");

try {
  await runCli(process.argv.slice(2), logger);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  logger.error("cli.failed", "umcp command failed", { message });
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

