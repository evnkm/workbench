// Pure translation from Codex app-server protocol objects to Workbench's
// provider-neutral conversation model. Covered by test/codex-mapping.test.ts
// using the recorded transcripts in probes/codex/samples.
import type {
  ConversationImage,
  FileChange,
  InputKind,
  InputQuestion,
  InputRequest,
  InputResponse,
  ItemData,
  ItemKind,
  ItemStatus,
  RunState,
} from "@workbench/contracts";
import type { ThreadItem } from "./protocol/v2/ThreadItem.ts";
import type { TurnStatus } from "./protocol/v2/TurnStatus.ts";

export const MAX_OUTPUT_CHARS = 64 * 1024;
export const MAX_DIFF_CHARS = 200 * 1024;

const clip = (s: string, max: number) => (s.length > max ? s.slice(s.length - max) : s);

function status(s: string | undefined | null): ItemStatus {
  switch (s) {
    case "inProgress":
      return "in_progress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "declined":
      return "declined";
    default:
      return null;
  }
}

export type MappedItem = { kind: ItemKind; status: ItemStatus; data: ItemData; clientId?: string | null };

export function mapItem(item: ThreadItem, completed: boolean): MappedItem {
  const done: ItemStatus = completed ? "completed" : "in_progress";
  switch (item.type) {
    case "userMessage": {
      const text = item.content
        .map((c) =>
          c.type === "text" ? c.text : c.type === "mention" || c.type === "skill" ? `@${c.name}` : `[${c.type}]`,
        )
        .join("\n");
      const images = item.content.flatMap((content): ConversationImage[] =>
        content.type === "localImage"
          ? [{ source: content.path, alt: "Attached image" }]
          : content.type === "image" && "url" in content
            ? [{ source: content.url, alt: "Attached image" }]
            : [],
      );
      return { kind: "user_message", status: "completed", data: { text, images }, clientId: item.clientId };
    }
    case "agentMessage":
      return { kind: "agent_message", status: done, data: { text: item.text, phase: item.phase ?? null } };
    case "reasoning":
      return { kind: "reasoning", status: done, data: { text: [...item.summary, ...item.content].join("\n\n") } };
    case "plan":
      return { kind: "plan", status: done, data: { text: item.text } };
    case "commandExecution": {
      const out = item.aggregatedOutput ?? "";
      return {
        kind: "command",
        status: status(item.status),
        data: {
          command: unwrapShell(item.command),
          cwd: item.cwd,
          output: clip(out, MAX_OUTPUT_CHARS),
          outputTruncated: out.length > MAX_OUTPUT_CHARS,
          exitCode: item.exitCode,
          durationMs: item.durationMs,
        },
      };
    }
    case "fileChange":
      return {
        kind: "file_change",
        status: status(item.status),
        data: {
          changes: item.changes.map(
            (c): FileChange => ({
              path: c.path,
              kind: c.kind.type,
              movePath: c.kind.type === "update" ? c.kind.move_path : null,
              diff: c.diff.length > MAX_DIFF_CHARS ? `${c.diff.slice(0, MAX_DIFF_CHARS)}\n… diff truncated` : c.diff,
            }),
          ),
        },
      };
    case "mcpToolCall":
      return {
        kind: "tool_call",
        status: status(item.status),
        data: {
          tool: item.tool,
          server: item.server,
          arguments: item.arguments,
          images: mcpImages(item.result?.content ?? []),
          result: item.result ? clipJson(item.result.content.filter((content) => !isMcpImage(content))) : null,
          error: item.error?.message ?? null,
          durationMs: item.durationMs,
        },
      };
    case "dynamicToolCall":
      return {
        kind: "tool_call",
        status: item.success === false ? "failed" : status(item.status),
        data: {
          tool: item.tool,
          server: item.namespace,
          arguments: item.arguments,
          durationMs: item.durationMs,
          images: (item.contentItems ?? []).flatMap((content) =>
            content.type === "inputImage" ? [{ source: content.imageUrl, alt: "Tool image" }] : [],
          ),
          result: clipJson((item.contentItems ?? []).filter((content) => content.type === "inputText")),
        },
      };
    case "functionCallOutput":
      return {
        kind: "tool_call",
        status: done,
        data: {
          tool: item.name,
          server: item.namespace,
          result:
            typeof item.output === "string"
              ? clip(item.output, MAX_OUTPUT_CHARS)
              : clipJson(item.output.filter((content) => content.type === "input_text")),
          images:
            typeof item.output === "string"
              ? []
              : item.output.flatMap((content) =>
                  content.type === "input_image" && "image_url" in content
                    ? [{ source: content.image_url, alt: "Tool image" }]
                    : [],
                ),
        },
      };
    case "imageView":
      return { kind: "image", status: done, data: { images: [{ source: item.path, alt: "Viewed image" }] } };
    case "imageGeneration":
      return {
        kind: "image",
        status: item.failure ? "failed" : done,
        data: {
          images:
            item.savedPath || item.result
              ? [
                  {
                    source: item.savedPath ?? `data:image/png;base64,${item.result}`,
                    alt: item.revisedPrompt ?? "Generated image",
                  },
                ]
              : [],
          error: item.failure ? "Image generation failed." : null,
        },
      };
    case "webSearch":
      return { kind: "web_search", status: done, data: { query: (item as { query?: string }).query ?? "" } };
    case "contextCompaction":
      return { kind: "notice", status: "completed", data: { text: "Context compacted." } };
    case "enteredReviewMode":
      return { kind: "notice", status: "completed", data: { text: `Review started: ${item.review}` } };
    case "exitedReviewMode":
      return { kind: "notice", status: "completed", data: { text: item.review } };
    default:
      return { kind: "other", status: done, data: { providerType: item.type } };
  }
}

function isMcpImage(value: unknown): value is { type: "image"; data: string; mimeType: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "image" &&
    "data" in value &&
    typeof value.data === "string" &&
    "mimeType" in value &&
    typeof value.mimeType === "string"
  );
}

function mcpImages(content: unknown[]): ConversationImage[] {
  return content
    .filter(isMcpImage)
    .map((image) => ({ source: `data:${image.mimeType};base64,${image.data}`, alt: "Tool image" }));
}

/** Codex wraps commands as `/bin/bash -lc '<cmd>'` (or double-quoted); show the inner command. */
export function unwrapShell(command: string): string {
  const single = /^\/bin\/(?:ba|z)?sh -lc '(.*)'$/s.exec(command);
  if (single) return single[1]!.replace(/'\\''/g, "'");
  const double = /^\/bin\/(?:ba|z)?sh -lc "(.*)"$/s.exec(command);
  if (double) return double[1]!.replace(/\\(["\\$`])/g, "$1");
  return command;
}

function clipJson(v: unknown): unknown {
  const s = JSON.stringify(v);
  return s.length > MAX_OUTPUT_CHARS ? `${s.slice(0, MAX_OUTPUT_CHARS)}… (truncated)` : v;
}

export function runStateForTurn(s: TurnStatus, interruptRequested: boolean): RunState {
  switch (s) {
    case "completed":
      return "succeeded";
    case "failed":
      return "failed";
    case "interrupted":
      return interruptRequested ? "cancelled" : "interrupted";
    default:
      return "running";
  }
}

// ---------------------------------------------------------------- server requests

export type MappedRequest =
  | { supported: true; kind: InputKind; request: InputRequest }
  | { supported: false; reason: string; reply: unknown };

const DECISION_LABELS: Record<string, string> = {
  accept: "Approve",
  acceptForSession: "Approve for session",
  decline: "Decline",
  cancel: "Decline and stop turn",
};

function decisionsFrom(available: unknown): { id: string; label: string }[] {
  const ids = Array.isArray(available)
    ? available.filter((d): d is string => typeof d === "string")
    : ["accept", "acceptForSession", "cancel"];
  // Codex accepts "decline" even when it is not listed; offer it so the agent can continue.
  if (!ids.includes("decline")) ids.splice(Math.max(0, ids.indexOf("cancel")), 0, "decline");
  return ids.filter((d) => d in DECISION_LABELS).map((id) => ({ id, label: DECISION_LABELS[id]! }));
}

export function mapServerRequest(method: string, params: Record<string, unknown>): MappedRequest {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return {
        supported: true,
        kind: "command_approval",
        request: {
          title: "Run command?",
          command: typeof params.command === "string" ? unwrapShell(params.command) : null,
          cwd: (params.cwd as string) ?? null,
          reason: (params.reason as string) ?? null,
          decisions: decisionsFrom(params.availableDecisions),
        },
      };
    case "item/fileChange/requestApproval":
      return {
        supported: true,
        kind: "file_approval",
        request: {
          title: "Apply file changes?",
          reason: (params.reason as string) ?? null,
          decisions: decisionsFrom(["accept", "acceptForSession", "decline", "cancel"]),
        },
      };
    case "item/tool/requestUserInput": {
      const questions = (params.questions as Record<string, unknown>[]).map(
        (q): InputQuestion => ({
          id: String(q.id),
          header: String(q.header ?? ""),
          question: String(q.question ?? ""),
          options: (q.options as InputQuestion["options"]) ?? null,
          allowOther: Boolean(q.isOther),
          secret: Boolean(q.isSecret),
        }),
      );
      return { supported: true, kind: "question", request: { title: "Codex has a question", questions } };
    }
    case "item/permissions/requestApproval":
      return {
        supported: false,
        reason:
          "Codex asked for additional sandbox permissions, which Workbench does not support yet. It was declined.",
        reply: { permissions: {}, scope: "turn" },
      };
    case "mcpServer/elicitation/request":
      return {
        supported: false,
        reason: `The MCP server ${String(params.serverName)} asked for input, which Workbench does not support yet. It was declined.`,
        reply: { action: "decline", content: null, _meta: null },
      };
    case "applyPatchApproval":
    case "execCommandApproval":
      return {
        supported: false,
        reason: "Codex sent a legacy approval request, which Workbench declines.",
        reply: { decision: { denied: { rejection: "Workbench does not support legacy approval requests." } } },
      };
    default:
      return { supported: false, reason: `Unsupported Codex request ${method} was rejected.`, reply: null };
  }
}

/** Translate a browser response into the app-server reply payload. */
export function replyFor(kind: InputKind, response: InputResponse): unknown {
  if (kind === "question") {
    if (response.kind !== "answers") throw new Error("A question needs answers.");
    return {
      answers: Object.fromEntries(Object.entries(response.answers).map(([id, answers]) => [id, { answers }])),
    };
  }
  if (response.kind !== "decision") throw new Error("An approval needs a decision.");
  if (!["accept", "acceptForSession", "decline", "cancel"].includes(response.decision)) {
    throw new Error(`Unknown decision ${response.decision}`);
  }
  return { decision: response.decision };
}
