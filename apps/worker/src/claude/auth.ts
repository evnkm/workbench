import type { WorkerStatus } from "@workbench/contracts";
import { exec } from "@workbench/runtime";

// Workbench uses the local claude.ai login. Do not let inherited API keys,
// gateways, cloud-provider flags, or setup tokens select another billing path.
export function subscriptionEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_CODE_USE_") || key === "CLAUDE_CODE_OAUTH_TOKEN")
      delete clean[key];
  }
  return { ...clean, CLAUDE_AGENT_SDK_CLIENT_APP: "workbench" };
}

export async function subscriptionStatus(bin: string): Promise<WorkerStatus["claude"]> {
  const result = await exec(bin, ["auth", "status", "--json"], { env: subscriptionEnv(), timeoutMs: 10_000 });
  let auth: { loggedIn?: boolean; authMethod?: string; apiProvider?: string };
  try {
    auth = JSON.parse(result.stdout);
  } catch {
    return {
      state: "unavailable",
      reason: `Could not check the local Claude login (${bin}). Install Claude Code and run claude auth login.`,
    };
  }
  if (
    result.code !== 0 ||
    auth?.loggedIn !== true ||
    auth.authMethod !== "claude.ai" ||
    auth.apiProvider !== "firstParty"
  ) {
    return {
      state: "unavailable",
      reason: "Sign in to your Claude subscription on this machine with claude auth login, then restart the worker.",
    };
  }
  return { state: "ready", reason: null };
}
