import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { createTestLogger } from "./helpers.js";

test("loadConfig auto-creates default JSONC config when missing", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "umcp-config-test-"));
  const configPath = path.join(tmpDir, "umcp.config.jsonc");

  try {
    const first = await loadConfig({ configPath, logger: createTestLogger() });
    assert.equal(first.created, true);
    assert.ok(first.config.categories.web_search);

    const second = await loadConfig({ configPath, logger: createTestLogger() });
    assert.equal(second.created, false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects non-jsonc path", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "umcp-config-test-"));
  const configPath = path.join(tmpDir, "umcp.config.json");

  try {
    await assert.rejects(
      () => loadConfig({ configPath, logger: createTestLogger() }),
      /Only JSONC config files are supported/
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig validates transport requirements", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "umcp-config-test-"));
  const configPath = path.join(tmpDir, "umcp.config.jsonc");

  const invalid = `{
    "categories": {
      "web_search": {
        "providers": [
          {
            "name": "brave",
            "transport": "stdio"
          }
        ]
      }
    }
  }`;

  try {
    await fs.writeFile(configPath, invalid, "utf8");
    await assert.rejects(
      () => loadConfig({ configPath, logger: createTestLogger() }),
      /provider.command is required when transport is stdio/
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

