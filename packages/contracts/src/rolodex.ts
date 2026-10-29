import { z } from "zod";

export const rolodexPlanSchema = z.object({
  reply: z.string().max(6000),
  people: z
    .array(
      z.object({
        key: z.string().min(1).max(100),
        name: z.string().trim().min(1).max(160),
        renameTo: z.string().trim().min(1).max(160).nullable(),
        existingId: z.string().nullable(),
        headline: z.string().max(300).nullable(),
        details: z.array(z.string().max(2000)).max(30),
        removeDetails: z.array(z.string().max(2000)).max(30),
        tags: z.array(z.string().max(50)).max(12),
        aliases: z.array(z.string().max(160)).max(12),
      }),
    )
    .max(30),
  connections: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        label: z.string().trim().min(1).max(120),
        context: z.string().max(2000),
        action: z.enum(["upsert", "remove"]),
      }),
    )
    .max(60),
});
export type RolodexPlan = z.infer<typeof rolodexPlanSchema>;
export type Person = {
  id: string;
  name: string;
  headline: string;
  details: string[];
  tags: string[];
  aliases: string[];
  createdAt: string;
  updatedAt: string;
};
export type Connection = { id: string; from: string; to: string; label: string; context: string; updatedAt: string };
export type IdentityQuestion = {
  key: string;
  name: string;
  details: string[];
  candidates: Person[];
  /** The likely match: the agent's existingId, or the only candidate. Listed first. */
  suggested: string | null;
};
export type RolodexMessage = {
  id: string;
  text: string;
  provider: "codex" | "claude";
  status: "queued" | "running" | "confirm" | "done" | "failed" | "cancelled";
  reply: string;
  error: string | null;
  questions: IdentityQuestion[];
  createdAt: string;
};
export type RolodexState = {
  revision: number;
  people: Person[];
  connections: Connection[];
  messages: RolodexMessage[];
};
export const rolodexMessageSchema = z.object({
  id: z.uuid(),
  text: z.string().trim().min(1).max(20000),
  provider: z.enum(["codex", "claude"]),
});
export const rolodexResolutionSchema = z.object({
  choices: z.record(z.string(), z.string().nullable()),
  cancel: z.boolean().optional(),
});
