import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { subscriptionEnv, subscriptionStatus } from "../src/claude/auth.ts";

test("subscription processes cannot inherit API keys, setup tokens, gateways, or cloud-provider overrides", () => {
  const source = {
    HOME: "/home/test",
    PATH: "/bin",
    CLAUDE_CONFIG_DIR: "/account",
    ANTHROPIC_API_KEY: "api-key",
    ANTHROPIC_AUTH_TOKEN: "gateway-token",
    ANTHROPIC_BASE_URL: "https://gateway.invalid",
    ANTHROPIC_PROFILE: "api-account",
    CLAUDE_CODE_OAUTH_TOKEN: "setup-token",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
    CLAUDE_CODE_USE_FOUNDRY: "1",
  };
  assert.deepEqual(subscriptionEnv(source), {
    HOME: "/home/test",
    PATH: "/bin",
    CLAUDE_CONFIG_DIR: "/account",
    CLAUDE_AGENT_SDK_CLIENT_APP: "workbench",
  });
  assert.equal(source.ANTHROPIC_API_KEY, "api-key");
});

test("readiness requires a first-party subscription login and fails visibly for missing or invalid login checks", async () => {
  const bin = join(import.meta.dirname, "fake-claude.mjs");
  const old = process.env.FAKE_CLAUDE_AUTH;
  try {
    process.env.FAKE_CLAUDE_AUTH = "subscription";
    assert.equal((await subscriptionStatus(bin)).state, "ready");
    for (const mode of ["logged-out", "api-key", "malformed"]) {
      process.env.FAKE_CLAUDE_AUTH = mode;
      const status = await subscriptionStatus(bin);
      assert.equal(status.state, "unavailable");
      assert.match(status.reason!, /claude auth login/);
    }
    assert.equal((await subscriptionStatus("/missing/claude")).state, "unavailable");
  } finally {
    if (old === undefined) delete process.env.FAKE_CLAUDE_AUTH;
    else process.env.FAKE_CLAUDE_AUTH = old;
  }
});
