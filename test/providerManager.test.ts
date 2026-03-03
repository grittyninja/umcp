import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withDefaultNpmCache } from "../src/providerManager.js";

test("withDefaultNpmCache applies fallback for npx when cache is not set", () => {
  const result = withDefaultNpmCache("npx", { PATH: "/usr/bin" });
  assert.equal(result.applied, true);
  assert.equal(result.cacheDir, join(homedir(), ".cache", "umcp", "npm"));
  assert.equal(result.env.NPM_CONFIG_CACHE, join(homedir(), ".cache", "umcp", "npm"));
  assert.equal(result.env.npm_config_cache, join(homedir(), ".cache", "umcp", "npm"));
});

test("withDefaultNpmCache preserves explicit writable cache env", () => {
  const explicit = join(tmpdir(), "umcp-test-cache");
  const result = withDefaultNpmCache("npm", { NPM_CONFIG_CACHE: explicit });
  assert.equal(result.applied, false);
  assert.equal(result.env.NPM_CONFIG_CACHE, explicit);
});

test("withDefaultNpmCache overrides unwritable cache env", () => {
  const unwritable = "/var/empty/umcp-cache";
  const result = withDefaultNpmCache("npm", { npm_config_cache: unwritable });
  assert.equal(result.applied, true);
  assert.equal(result.env.NPM_CONFIG_CACHE, join(homedir(), ".cache", "umcp", "npm"));
});

test("withDefaultNpmCache ignores non npm-like commands", () => {
  const result = withDefaultNpmCache("node", { PATH: "/usr/bin" });
  assert.equal(result.applied, false);
  assert.equal(result.env.PATH, "/usr/bin");
  assert.equal(result.env.NPM_CONFIG_CACHE, undefined);
});
