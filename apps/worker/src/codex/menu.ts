import type { AgentModel, CommandPayload, Conversation, InspectResult, Workspace } from "@workbench/contracts";
import { CommandError } from "../commands.ts";
import type { AppServer } from "./appserver.ts";
import type { AppsListResponse } from "./protocol/v2/AppsListResponse.ts";
import type { GetAccountRateLimitsResponse } from "./protocol/v2/GetAccountRateLimitsResponse.ts";
import type { GetAccountTokenUsageResponse } from "./protocol/v2/GetAccountTokenUsageResponse.ts";
import type { HooksListResponse } from "./protocol/v2/HooksListResponse.ts";
import type { ListMcpServerStatusResponse } from "./protocol/v2/ListMcpServerStatusResponse.ts";
import type { ModelListResponse } from "./protocol/v2/ModelListResponse.ts";
import type { PluginInstalledResponse } from "./protocol/v2/PluginInstalledResponse.ts";
import type { SkillsListResponse } from "./protocol/v2/SkillsListResponse.ts";

async function pages<T>(server: AppServer, method: string, params: object): Promise<T[]> {
  const data: T[] = [];
  let cursor: string | null = null;
  do {
    const page: { data: T[]; nextCursor: string | null } = await server.request(method, {
      ...params,
      cursor,
      limit: 100,
    });
    data.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return data;
}

export async function readModels(server: AppServer): Promise<AgentModel[]> {
  const models = await pages<ModelListResponse["data"][number]>(server, "model/list", { includeHidden: false });
  return models
    .filter((model) => !model.hidden)
    .map((model) => ({
      model: model.model,
      name: model.displayName,
      description: model.description,
      isDefault: model.isDefault,
      efforts: model.supportedReasoningEfforts.map((effort) => ({
        effort: effort.reasoningEffort,
        description: effort.description,
      })),
      defaultEffort: model.defaultReasoningEffort,
      serviceTiers: model.serviceTiers,
    }));
}

/** Return display data, never auth tokens, raw configuration, or arbitrary RPC results. */
export async function readMenu(
  server: AppServer,
  conv: Conversation,
  workspace: Workspace,
  view: CommandPayload<"conversation.inspect">["view"],
): Promise<InspectResult> {
  const threadId = conv.providerThreadId ?? undefined;
  switch (view) {
    case "models":
      return { kind: "models", models: await readModels(server) };
    case "commands":
      throw new CommandError("Codex has no native command list; its commands are in Workbench's slash menu.");
    case "status": {
      const rows = [
        { label: "Conversation", value: conv.id },
        { label: "Codex thread", value: threadId ?? "Not started" },
        { label: "Workspace", value: workspace.worktreePath },
        { label: "Model", value: conv.model ?? "Codex default" },
        { label: "Reasoning", value: conv.reasoningEffort ?? "Model default" },
        { label: "Service tier", value: conv.serviceTier ?? "Standard" },
        { label: "Approvals", value: conv.approvalPolicy },
      ];
      try {
        const res = await server.request<GetAccountRateLimitsResponse>("account/rateLimits/read", {});
        const limits = res.rateLimitsByLimitId ? Object.values(res.rateLimitsByLimitId) : [res.rateLimits];
        for (const limit of limits) {
          if (!limit) continue;
          for (const [name, window] of [
            ["Primary", limit.primary],
            ["Secondary", limit.secondary],
          ] as const) {
            if (window)
              rows.push({
                label: `${limit.limitName ?? limit.limitId ?? "Usage"} · ${name}`,
                value: `${window.usedPercent}% used${window.resetsAt ? ` · resets ${new Date(window.resetsAt * 1000).toISOString()}` : ""}`,
              });
          }
        }
      } catch (e) {
        rows.push({ label: "Rate limits", value: `Unavailable: ${(e as Error).message}` });
      }
      return { kind: "info", title: "Session status", rows };
    }
    case "usage": {
      const res = await server.request<GetAccountTokenUsageResponse>("account/tokenUsage/read", { threadId });
      return {
        kind: "info",
        title: "Token usage",
        rows: [
          { label: "Lifetime tokens", value: String(res.summary.lifetimeTokens ?? "Unavailable") },
          { label: "Peak daily tokens", value: String(res.summary.peakDailyTokens ?? "Unavailable") },
          { label: "Current streak (days)", value: String(res.summary.currentStreakDays ?? "Unavailable") },
        ],
      };
    }
    case "skills": {
      const res = await server.request<SkillsListResponse>("skills/list", { cwds: [workspace.worktreePath] });
      if (res.data.some((entry) => entry.errors.length))
        throw new Error(
          res.data
            .flatMap((entry) => entry.errors)
            .map((e) => e.message)
            .join("\n"),
        );
      return {
        kind: "choices",
        title: "Skills",
        choices: res.data
          .flatMap((entry) => entry.skills)
          .filter((s) => s.enabled)
          .map((s) => ({ label: s.name, description: s.shortDescription ?? s.description, text: `$${s.name} ` })),
      };
    }
    case "apps": {
      const apps = await pages<AppsListResponse["data"][number]>(server, "app/list", { threadId });
      return {
        kind: "choices",
        title: "Apps",
        choices: apps
          .filter((app) => app.isAccessible && app.isEnabled)
          .map((app) => ({
            label: app.name,
            description: app.description ?? "Connected app",
            text: `[$${app.name}](app://${app.id}) `,
          })),
      };
    }
    case "mcp": {
      const servers = await pages<ListMcpServerStatusResponse["data"][number]>(server, "mcpServerStatus/list", {
        threadId,
      });
      return {
        kind: "info",
        title: "MCP servers",
        rows: servers.map((s) => ({
          label: s.name,
          value: `${s.runtimeStatus ?? s.authStatus} · ${Object.keys(s.tools).length} tools${s.toolsError ? ` · ${s.toolsError}` : ""}`,
        })),
      };
    }
    case "plugins": {
      const res = await server.request<PluginInstalledResponse>("plugin/installed", { cwds: [workspace.worktreePath] });
      if (res.marketplaceLoadErrors.length) throw new Error(res.marketplaceLoadErrors.map((e) => e.message).join("\n"));
      return {
        kind: "info",
        title: "Installed plugins",
        rows: res.marketplaces
          .flatMap((m) => m.plugins)
          .filter((p) => p.installed)
          .map((p) => ({ label: p.name, value: p.enabled ? "Enabled" : "Disabled" })),
      };
    }
    case "hooks": {
      const res = await server.request<HooksListResponse>("hooks/list", { cwds: [workspace.worktreePath] });
      if (res.data.some((entry) => entry.errors.length))
        throw new Error(
          res.data
            .flatMap((entry) => entry.errors)
            .map((e) => e.message)
            .join("\n"),
        );
      return {
        kind: "info",
        title: "Lifecycle hooks",
        rows: res.data.flatMap((entry) => [
          ...entry.hooks.map((h) => ({
            label: h.eventName,
            value: `${h.enabled ? "Enabled" : "Disabled"} · ${h.trustStatus} · ${h.sourcePath}`,
          })),
          ...entry.warnings.map((warning) => ({ label: "Warning", value: warning })),
        ]),
      };
    }
  }
}
