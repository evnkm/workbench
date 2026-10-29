import { join } from "node:path";
import type { WorkerContext } from "./context.ts";

// The command reads the live database rather than a startup snapshot. Quoting
// each argument keeps workspace paths and IDs out of shell syntax.
export function sessionInstructions(ctx: WorkerContext, workspaceId: string, conversationId: string): string {
  const quote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;
  const command = [
    process.execPath,
    join(import.meta.dirname, "session-status.ts"),
    ctx.config.dbPath,
    workspaceId,
    conversationId,
  ]
    .map(quote)
    .join(" ");
  return `This worktree is shared by concurrent Workbench agent conversations. Other sessions may start or edit files while you work.
Before editing, committing, or running repository-wide mutations, inspect the live sessions and their recent tool activity with:
${command}
Coordinate scope with the other sessions' tasks. Prefer distinct files; if their work overlaps yours, pause only the overlapping edits and ask the user how to split ownership. Recheck current file contents and Git diffs before applying changes. Preserve edits made by other sessions. Stage and commit only your own changes; never use broad reset, clean, checkout, stash, or git add -A to manage someone else's work. Do not run simultaneous schema migrations or dependency installs. Independent work may continue. Use separate worktrees when overlapping changes require isolation.`;
}
