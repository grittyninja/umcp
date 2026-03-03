import type { EnvValue } from "./config.js";
import type { Logger } from "./logger.js";
import { maskSecret } from "./logger.js";

type EnvMap = Record<string, EnvValue> | undefined;

type RoundRobinState = Map<string, Map<string, number>>;

export function hasRotatingEnv(env: EnvMap): boolean {
  if (!env) {
    return false;
  }
  return Object.values(env).some((value) => Array.isArray(value));
}

function resolveFirstEnvValues(env: EnvMap): Record<string, string> {
  if (!env) {
    return {};
  }

  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      resolved[key] = value;
      continue;
    }
    resolved[key] = value[0] ?? "";
  }
  return resolved;
}

export function createRoundRobinEnvPool(logger: Logger) {
  const state: RoundRobinState = new Map();

  function next(providerId: string, env: EnvMap): Record<string, string> {
    if (!env) {
      return {};
    }

    const resolved: Record<string, string> = {};
    const providerState = state.get(providerId) ?? new Map<string, number>();
    state.set(providerId, providerState);

    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") {
        resolved[key] = value;
        continue;
      }

      const currentIndex = providerState.get(key) ?? 0;
      const selected = value[currentIndex % value.length] ?? "";
      const nextIndex = (currentIndex + 1) % value.length;
      providerState.set(key, nextIndex);
      resolved[key] = selected;

      logger.info("env.rotated", "Rotated env key using round-robin", {
        providerId,
        key,
        selectedIndex: currentIndex % value.length,
        poolSize: value.length,
        valuePreview: maskSecret(selected)
      });
    }

    return resolved;
  }

  return {
    hasRotatingEnv,
    discoveryValues: resolveFirstEnvValues,
    next
  };
}

