export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export type LogContext = Record<string, unknown> | undefined;

export type Logger = ReturnType<typeof createLogger>;

export function createLogger(level: LogLevel = "info") {
  function log(logLevel: LogLevel, event: string, msg: string, context?: LogContext): void {
    if (LOG_LEVEL_WEIGHT[logLevel] < LOG_LEVEL_WEIGHT[level]) {
      return;
    }

    const entry = {
      ts: new Date().toISOString(),
      level: logLevel,
      event,
      msg,
      context
    };

    process.stderr.write(`${JSON.stringify(entry)}\n`);
  }

  return {
    debug: (event: string, msg: string, context?: LogContext) => log("debug", event, msg, context),
    info: (event: string, msg: string, context?: LogContext) => log("info", event, msg, context),
    warn: (event: string, msg: string, context?: LogContext) => log("warn", event, msg, context),
    error: (event: string, msg: string, context?: LogContext) => log("error", event, msg, context)
  };
}

export function maskSecret(value: string): string {
  if (value.length <= 4) {
    return "***";
  }

  const head = value.slice(0, 2);
  const tail = value.slice(-2);
  return `${head}***${tail}`;
}

