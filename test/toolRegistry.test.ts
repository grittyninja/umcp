import assert from "node:assert/strict";
import test from "node:test";
import type { UmcpConfig } from "../src/config.js";
import { discoverUnifiedTools, formatDryRun } from "../src/toolRegistry.js";
import { createTestLogger } from "./helpers.js";

function createProviderManagerMock() {
  const providerRefs = [
    {
      category: "web_search",
      providerId: "web_search.brave",
      provider: {
        name: "brave",
        transport: "stdio",
        command: "npx"
      }
    },
    {
      category: "project_mgmt",
      providerId: "project_mgmt.linear",
      provider: {
        name: "linear",
        transport: "streamable-http",
        url: "https://example.com/mcp",
        tools: [{ upstream: "create_issue", alias: "add_task", enabled: true }]
      }
    }
  ];

  const toolsByProvider: Record<string, Array<{ name: string; description?: string }>> = {
    "web_search.brave": [
      { name: "search", description: "Search the web" },
      { name: "images", description: "Search images" }
    ],
    "project_mgmt.linear": [{ name: "create_issue", description: "Create issue" }]
  };

  return {
    getProviderRefs: () => providerRefs,
    listTools: async (providerId: string) => toolsByProvider[providerId] ?? [],
    callTool: async () => ({ content: [] }),
    close: async () => undefined
  };
}

test("discoverUnifiedTools supports auto-discovery and alias mapping", async () => {
  const config = {
    categories: {
      web_search: {
        providers: [{ name: "brave", transport: "stdio", command: "npx" }]
      },
      project_mgmt: {
        providers: [
          {
            name: "linear",
            transport: "streamable-http",
            url: "https://example.com/mcp",
            tools: [{ upstream: "create_issue", alias: "add_task", enabled: true }]
          }
        ]
      }
    }
  } as UmcpConfig;

  const bindings = await discoverUnifiedTools(
    config,
    createProviderManagerMock() as any,
    createTestLogger()
  );

  const names = bindings.map((b) => b.finalName);
  assert.deepEqual(names, [
    "project_mgmt_linear_add_task",
    "web_search_brave_images",
    "web_search_brave_search"
  ]);

  const report = formatDryRun(bindings);
  assert.match(report, /project_mgmt_linear_add_task/);
  assert.match(report, /web_search_brave_search/);
});

test("discoverUnifiedTools rejects invalid alias segments", async () => {
  const config = {
    categories: {
      web_search: {
        providers: [
          {
            name: "a",
            transport: "stdio",
            command: "npx",
            tools: [{ upstream: "search", alias: "b.c" }]
          },
          {
            name: "b",
            transport: "stdio",
            command: "npx",
            tools: [{ upstream: "search", alias: "c" }]
          }
        ]
      }
    }
  } as UmcpConfig;

  const manager = {
    getProviderRefs: () => [
      {
        category: "web_search",
        providerId: "web_search.a",
        provider: config.categories.web_search.providers[0]
      },
      {
        category: "web_search",
        providerId: "web_search.b",
        provider: config.categories.web_search.providers[1]
      }
    ],
    listTools: async () => [{ name: "search" }],
    callTool: async () => ({ content: [] }),
    close: async () => undefined
  };

  await assert.rejects(
    () => discoverUnifiedTools(config, manager as any, createTestLogger()),
    /Namespace segment values must match/
  );
});

test("discoverUnifiedTools rejects final names that exceed MCP name limits", async () => {
  const config = {
    categories: {
      very_long_category_name_that_pushes_the_tool_name_over_the_limit: {
        providers: [
          {
            name: "provider",
            transport: "stdio",
            command: "npx"
          }
        ]
      }
    }
  } as UmcpConfig;

  const manager = {
    getProviderRefs: () => [
      {
        category: "very_long_category_name_that_pushes_the_tool_name_over_the_limit",
        providerId: "very_long_category_name_that_pushes_the_tool_name_over_the_limit.provider",
        provider: config.categories.very_long_category_name_that_pushes_the_tool_name_over_the_limit.providers[0]
      }
    ],
    listTools: async () => [{ name: "search" }],
    callTool: async () => ({ content: [] }),
    close: async () => undefined
  };

  await assert.rejects(
    () => discoverUnifiedTools(config, manager as any, createTestLogger()),
    /violates \^\[a-zA-Z0-9_-\]\{1,64\}\$/
  );
});
