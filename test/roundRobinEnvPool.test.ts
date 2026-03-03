import assert from "node:assert/strict";
import test from "node:test";
import { createRoundRobinEnvPool } from "../src/roundRobinEnvPool.js";
import { createTestLogger } from "./helpers.js";

test("round robin rotates array env values per invocation", () => {
  const pool = createRoundRobinEnvPool(createTestLogger());
  const env = {
    BRAVE_API_KEY: ["k1", "k2", "k3"],
    STATIC: "always"
  };

  assert.deepEqual(pool.next("web_search.brave", env), {
    BRAVE_API_KEY: "k1",
    STATIC: "always"
  });
  assert.deepEqual(pool.next("web_search.brave", env), {
    BRAVE_API_KEY: "k2",
    STATIC: "always"
  });
  assert.deepEqual(pool.next("web_search.brave", env), {
    BRAVE_API_KEY: "k3",
    STATIC: "always"
  });
  assert.deepEqual(pool.next("web_search.brave", env), {
    BRAVE_API_KEY: "k1",
    STATIC: "always"
  });
});

test("round robin keeps independent cursors per provider and key", () => {
  const pool = createRoundRobinEnvPool(createTestLogger());
  const envA = { A: ["1", "2"], B: ["x", "y"] };
  const envB = { A: ["m", "n"] };

  assert.deepEqual(pool.next("provider.a", envA), { A: "1", B: "x" });
  assert.deepEqual(pool.next("provider.a", envA), { A: "2", B: "y" });
  assert.deepEqual(pool.next("provider.b", envB), { A: "m" });
  assert.deepEqual(pool.next("provider.b", envB), { A: "n" });
  assert.deepEqual(pool.next("provider.a", envA), { A: "1", B: "x" });
});

test("hasRotatingEnv and discoveryValues behavior", () => {
  const pool = createRoundRobinEnvPool(createTestLogger());

  assert.equal(pool.hasRotatingEnv(undefined), false);
  assert.equal(pool.hasRotatingEnv({ KEY: "single" }), false);
  assert.equal(pool.hasRotatingEnv({ KEY: ["a", "b"] }), true);

  assert.deepEqual(pool.discoveryValues(undefined), {});
  assert.deepEqual(pool.discoveryValues({ KEY: "single" }), { KEY: "single" });
  assert.deepEqual(pool.discoveryValues({ KEY: ["a", "b"], OTHER: "x" }), {
    KEY: "a",
    OTHER: "x"
  });
});

