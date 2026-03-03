import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UmcpConfig, ToolMappingConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { ProviderManager, ProviderRef, UpstreamTool } from "./providerManager.js";
import { NAMESPACE_SEGMENT_REGEX } from "./config.js";

export type UnifiedToolBinding = {
  providerId: string;
  category: string;
  providerName: string;
  upstreamName: string;
  finalName: string;
  description?: string;
  title?: string;
  inputSchema?: unknown;
};

const FALLBACK_INPUT_SCHEMA = z.object({}).passthrough();

function ensureToolSegment(
  value: string,
  context: { providerId: string; source: "alias" | "upstream" | "discovered" }
): string {
  if (!NAMESPACE_SEGMENT_REGEX.test(value)) {
    if (context.source === "discovered") {
      throw new Error(
        `Discovered tool '${value}' on '${context.providerId}' cannot be used as a namespace segment. ` +
          "Add an explicit tools mapping with a valid alias ([a-zA-Z0-9_-]+)."
      );
    }

    throw new Error(
      `Invalid ${context.source} '${value}' on '${context.providerId}'. ` +
        "Namespace segment values must match [a-zA-Z0-9_-]+."
    );
  }
  return value;
}

function toConfiguredMappings(
  providerRef: ProviderRef,
  discoveredTools: UpstreamTool[],
  mappings: ToolMappingConfig[]
): UnifiedToolBinding[] {
  const discoveredByName = new Map(discoveredTools.map((tool) => [tool.name, tool]));
  const bindings: UnifiedToolBinding[] = [];

  for (const mapping of mappings) {
    if (mapping.enabled === false) {
      continue;
    }

    const discovered = discoveredByName.get(mapping.upstream);
    if (!discovered) {
      throw new Error(
        `Configured tool '${mapping.upstream}' was not discovered on provider '${providerRef.providerId}'`
      );
    }

    const toolSegment = mapping.alias
      ? ensureToolSegment(mapping.alias, { providerId: providerRef.providerId, source: "alias" })
      : ensureToolSegment(mapping.upstream, { providerId: providerRef.providerId, source: "upstream" });
    bindings.push({
      providerId: providerRef.providerId,
      category: providerRef.category,
      providerName: providerRef.provider.name,
      upstreamName: discovered.name,
      finalName: `${providerRef.category}.${providerRef.provider.name}.${toolSegment}`,
      description: discovered.description,
      title: discovered.title,
      inputSchema: discovered.inputSchema
    });
  }

  return bindings;
}

function toDiscoveredMappings(providerRef: ProviderRef, discoveredTools: UpstreamTool[]): UnifiedToolBinding[] {
  return discoveredTools.map((tool) => ({
    ...(() => {
      const segment = ensureToolSegment(tool.name, {
        providerId: providerRef.providerId,
        source: "discovered"
      });
      return { finalName: `${providerRef.category}.${providerRef.provider.name}.${segment}` };
    })(),
    providerId: providerRef.providerId,
    category: providerRef.category,
    providerName: providerRef.provider.name,
    upstreamName: tool.name,
    description: tool.description,
    title: tool.title,
    inputSchema: tool.inputSchema
  }));
}

export async function discoverUnifiedTools(
  config: UmcpConfig,
  providerManager: ProviderManager,
  logger: Logger
): Promise<UnifiedToolBinding[]> {
  void config;
  const allBindings: UnifiedToolBinding[] = [];
  const seenFinalNames = new Map<string, UnifiedToolBinding>();

  for (const providerRef of providerManager.getProviderRefs()) {
    const discoveredTools = await providerManager.listTools(providerRef.providerId);
    logger.info("tool.discovered", "Discovered upstream tools", {
      providerId: providerRef.providerId,
      count: discoveredTools.length
    });

    const bindings = providerRef.provider.tools
      ? toConfiguredMappings(providerRef, discoveredTools, providerRef.provider.tools)
      : toDiscoveredMappings(providerRef, discoveredTools);

    for (const binding of bindings) {
      const collision = seenFinalNames.get(binding.finalName);
      if (collision) {
        throw new Error(
          `Final tool name collision: '${binding.finalName}' from '${binding.providerId}' and '${collision.providerId}'`
        );
      }
      seenFinalNames.set(binding.finalName, binding);
      allBindings.push(binding);
    }
  }

  allBindings.sort((a, b) => a.finalName.localeCompare(b.finalName));
  return allBindings;
}

type SchemaConversion = {
  schema: z.ZodTypeAny;
  fallbackUsed: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTypeArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  if (!value.every((item) => typeof item === "string")) {
    return undefined;
  }
  return value as string[];
}

function convertJsonSchemaToZod(inputSchema: unknown): SchemaConversion {
  function convert(schema: unknown): SchemaConversion {
    if (!isRecord(schema)) {
      return { schema: z.unknown(), fallbackUsed: true };
    }

    if (schema.const !== undefined) {
      if (isLiteralValue(schema.const)) {
        return { schema: z.literal(schema.const), fallbackUsed: false };
      }
      return { schema: z.unknown(), fallbackUsed: true };
    }

    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
      if (schema.enum.length === 1) {
        return {
          schema: z.literal(schema.enum[0]),
          fallbackUsed: false
        };
      }

      const enumLiterals = schema.enum.map((value) => z.literal(value));
      return {
        schema: z.union(
          enumLiterals as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]
        ),
        fallbackUsed: false
      };
    }

    if (Array.isArray(schema.oneOf) && schema.oneOf.length >= 2) {
      const converted = schema.oneOf.map((entry) => convert(entry));
      const schemaUnion = z.union(
        converted.map((item) => item.schema) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]
      );
      return {
        schema: schemaUnion,
        fallbackUsed: converted.some((item) => item.fallbackUsed)
      };
    }

    if (Array.isArray(schema.anyOf) && schema.anyOf.length >= 2) {
      const converted = schema.anyOf.map((entry) => convert(entry));
      const schemaUnion = z.union(
        converted.map((item) => item.schema) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]
      );
      return {
        schema: schemaUnion,
        fallbackUsed: converted.some((item) => item.fallbackUsed)
      };
    }

    const typeValue = schema.type;
    if (Array.isArray(typeValue)) {
      const typeArray = asTypeArray(typeValue);
      if (!typeArray) {
        return { schema: z.unknown(), fallbackUsed: true };
      }

      const variants = typeArray.map((singleType) =>
        convert({
          ...schema,
          type: singleType
        })
      );

      const nonNullVariants = variants.filter((variant, index) => typeArray[index] !== "null");
      const hasNull = typeArray.includes("null");
      if (nonNullVariants.length === 0) {
        return { schema: z.null(), fallbackUsed: false };
      }
      if (nonNullVariants.length === 1) {
        const firstVariant = nonNullVariants[0];
        return {
          schema: hasNull ? firstVariant.schema.nullable() : firstVariant.schema,
          fallbackUsed: firstVariant.fallbackUsed
        };
      }

      const unionSchema = z.union(
        nonNullVariants.map((variant) => variant.schema) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]
      );

      return {
        schema: hasNull ? unionSchema.nullable() : unionSchema,
        fallbackUsed: variants.some((variant) => variant.fallbackUsed)
      };
    }

    switch (typeValue) {
      case "object": {
        const properties = isRecord(schema.properties) ? schema.properties : {};
        const required = Array.isArray(schema.required)
          ? new Set(schema.required.filter((entry): entry is string => typeof entry === "string"))
          : new Set<string>();

        const shape: Record<string, z.ZodTypeAny> = {};
        let fallbackUsed = false;

        for (const [key, childSchema] of Object.entries(properties)) {
          const converted = convert(childSchema);
          fallbackUsed ||= converted.fallbackUsed;
          shape[key] = required.has(key) ? converted.schema : converted.schema.optional();
        }

        let objectSchema = z.object(shape);
        if (schema.additionalProperties === false) {
          objectSchema = objectSchema.strict();
        } else {
          objectSchema = objectSchema.passthrough();
        }

        return {
          schema: objectSchema,
          fallbackUsed
        };
      }
      case "array": {
        const itemConversion = convert(schema.items);
        return {
          schema: z.array(itemConversion.schema),
          fallbackUsed: itemConversion.fallbackUsed
        };
      }
      case "string":
        return { schema: z.string(), fallbackUsed: false };
      case "integer":
        return { schema: z.number().int(), fallbackUsed: false };
      case "number":
        return { schema: z.number(), fallbackUsed: false };
      case "boolean":
        return { schema: z.boolean(), fallbackUsed: false };
      case "null":
        return { schema: z.null(), fallbackUsed: false };
      default:
        return { schema: z.unknown(), fallbackUsed: true };
    }
  }

  if (!inputSchema) {
    return { schema: FALLBACK_INPUT_SCHEMA, fallbackUsed: false };
  }

  const converted = convert(inputSchema);
  if (converted.schema instanceof z.ZodObject) {
    return converted;
  }

  return {
    schema: FALLBACK_INPUT_SCHEMA,
    fallbackUsed: true
  };
}

export function registerUnifiedTools(
  server: McpServer,
  bindings: UnifiedToolBinding[],
  providerManager: ProviderManager,
  logger: Logger
): void {
  for (const binding of bindings) {
    const conversion = convertJsonSchemaToZod(binding.inputSchema);
    if (conversion.fallbackUsed) {
      logger.warn("tool.schema_fallback", "Using permissive schema for tool", {
        finalName: binding.finalName,
        upstreamName: binding.upstreamName
      });
    }

    server.registerTool(
      binding.finalName,
      {
        title: binding.title,
        description:
          binding.description ??
          `Proxy for ${binding.providerId}.${binding.upstreamName} via umcp aggregation`,
        inputSchema: conversion.schema
      },
      (async (args: unknown) => {
        logger.info("tool.called", "Forwarding tool call to upstream provider", {
          finalName: binding.finalName,
          providerId: binding.providerId,
          upstreamName: binding.upstreamName
        });

        const result = await providerManager.callTool(
          binding.providerId,
          binding.upstreamName,
          (args ?? {}) as Record<string, unknown>
        );
        return result;
      }) as any
    );

    logger.info("tool.registered", "Registered unified tool", {
      finalName: binding.finalName,
      providerId: binding.providerId,
      upstreamName: binding.upstreamName
    });
  }
}

function isLiteralValue(value: unknown): value is string | number | boolean | bigint | null | undefined {
  return (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  );
}

export function formatDryRun(bindings: UnifiedToolBinding[]): string {
  const lines = [
    "Discovered unified tools:",
    ...bindings.map(
      (binding) => `- ${binding.finalName} -> ${binding.providerId}.${binding.upstreamName}`
    )
  ];
  return lines.join("\n");
}
