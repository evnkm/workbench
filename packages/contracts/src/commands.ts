// Browser mutations are durable commands. The server validates and persists
// them; the worker claims and executes them.
import { z } from "zod";
import { APPROVAL_POLICIES } from "./states.ts";

const id = z.string().min(1).max(64);
const name = z.string().trim().min(1).max(120);
// Git ref names: conservative subset that is always valid for `git check-ref-format --branch`.
const branch = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^(?!\/|.*\/\/|.*\.\.|.*@\{|.*\.lock$|.*\/$|.*\.$)[A-Za-z0-9._/-]+$/, "invalid branch name");

export const commandSchemas = {
  "project.register": z.object({
    path: z.string().min(1).max(4096),
    name: name.optional(),
    defaultBranch: z.string().trim().min(1).max(200).optional(),
    setupCommand: z.string().max(4000).nullable().optional(),
  }),
  "project.update": z.object({
    projectId: id,
    name: name.optional(),
    defaultBranch: z.string().trim().min(1).max(200).optional(),
    setupCommand: z.string().max(4000).nullable().optional(),
    runCommand: z.string().max(4000).nullable().optional(),
  }),
  "workspace.create": z.object({
    projectId: id,
    name,
    branch: branch.optional(),
    baseRef: z.string().trim().min(1).max(200).optional(),
  }),
  "workspace.rename": z.object({ workspaceId: id, name }),
  "workspace.retry": z.object({ workspaceId: id }),
  "workspace.archive": z.object({ workspaceId: id }),
  "workspace.restore": z.object({ workspaceId: id }),
  "conversation.create": z.object({
    workspaceId: id,
    provider: z.enum(["codex", "claude"]),
    title: z.string().trim().max(200).optional(),
    approvalPolicy: z.enum(APPROVAL_POLICIES).default("never"),
    model: z.string().max(100).optional(),
  }),
  "conversation.rename": z.object({ conversationId: id, title: name }),
  "turn.start": z.object({
    conversationId: id,
    text: z.string().min(1).max(100_000),
    mode: z.enum(["default", "plan"]).default("default"),
  }),
  "turn.interrupt": z.object({ conversationId: id, runId: id }),
  "input.respond": z.object({
    inputId: id,
    response: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("decision"), decision: z.string().min(1).max(100) }),
      z.object({ kind: z.literal("answers"), answers: z.record(z.string(), z.array(z.string().max(10_000)).max(20)) }),
    ]),
  }),
  "shell.create": z.object({ workspaceId: id, name: z.string().trim().max(60).optional() }),
  "shell.kill": z.object({ processId: id }),
  "app.start": z.object({ workspaceId: id }),
  "app.stop": z.object({ processId: id }),
  "job.create": z.object({
    name,
    workspaceId: id.nullable(),
    projectId: id.nullable(),
    kind: z.enum(["shell", "codex"]),
    command: z.string().min(1).max(20_000),
    isolation: z.enum(["workspace", "worktree"]).default("workspace"),
    timeoutSeconds: z.number().int().min(10).max(86_400).default(3600),
    maxAttempts: z.number().int().min(1).max(5).default(1),
    retryUnknownOutcome: z.boolean().default(false),
    schedule: z
      .object({
        cron: z.string().min(9).max(120),
        timezone: z.string().min(1).max(64).default("UTC"),
        overlap: z.enum(["skip", "queue"]).default("skip"),
      })
      .nullable()
      .default(null),
  }),
  "job.update": z.object({
    jobId: id,
    name: name.optional(),
    command: z.string().min(1).max(20_000).optional(),
    timeoutSeconds: z.number().int().min(10).max(86_400).optional(),
    paused: z.boolean().optional(),
    schedule: z
      .object({
        cron: z.string().min(9).max(120),
        timezone: z.string().min(1).max(64),
        overlap: z.enum(["skip", "queue"]),
      })
      .nullable()
      .optional(),
  }),
  "job.delete": z.object({ jobId: id }),
  "job.launch": z.object({ jobId: id }),
  "job.cancel": z.object({ runId: id }),
  "job.retry": z.object({ runId: id }),
  "artifact.pin": z.object({ artifactId: id, pinned: z.boolean() }),
  "notification.markRead": z.object({ runIds: z.array(id).max(500) }),
} as const;

export type CommandType = keyof typeof commandSchemas;
export type CommandPayload<T extends CommandType> = z.output<(typeof commandSchemas)[T]>;

export const COMMAND_TYPES = Object.keys(commandSchemas) as CommandType[];

export const commandRequestSchema = z.object({
  requestId: z.string().min(8).max(100),
  type: z.enum(COMMAND_TYPES as [CommandType, ...CommandType[]]),
  payload: z.unknown(),
});

/** Validate a command payload; throws a ZodError on invalid input. */
export function parseCommandPayload<T extends CommandType>(type: T, payload: unknown): CommandPayload<T> {
  return commandSchemas[type].parse(payload) as CommandPayload<T>;
}
