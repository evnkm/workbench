// Conversation actions and the CLI command names users already know. Commands
// owned by another surface remain discoverable with an explicit availability note.
export const SLASH_COMMANDS = [
  { name: "model", description: "Choose a model and reasoning effort" },
  { name: "fast", description: "Choose Standard or a model's Fast service tier" },
  { name: "reasoning", description: "Change reasoning effort for the next turn" },
  { name: "permissions", description: "Change when the agent must ask for approval" },
  { name: "plan", description: "Toggle Plan mode, or plan an inline prompt" },
  { name: "review", description: "Review uncommitted changes or compare with a branch" },
  { name: "status", description: "Inspect session settings and rate limits" },
  { name: "usage", description: "Inspect account token usage" },
  { name: "compact", description: "Compact this conversation's Codex context" },
  { name: "fork", description: "Continue a copy of this conversation in a new tab" },
  { name: "new", description: "Start a new conversation in this workspace" },
  { name: "clear", description: "Start a fresh conversation; keep the existing history" },
  { name: "resume", description: "Switch to a saved Workbench conversation" },
  { name: "rename", description: "Rename this conversation" },
  { name: "delete", description: "Delete this conversation and its Workbench history" },
  { name: "diff", description: "Open the workspace's Git changes" },
  { name: "copy", description: "Copy the latest completed assistant response" },
  { name: "skills", description: "Browse enabled skills and insert one into your prompt" },
  { name: "apps", description: "Browse connected apps and insert one into your prompt" },
  { name: "plugins", description: "Inspect installed plugins" },
  { name: "hooks", description: "Inspect configured lifecycle hooks" },
  { name: "mcp", description: "Inspect MCP servers and tool availability" },
  { name: "init", description: "Draft a request to create project instructions in AGENTS.md" },
  { name: "mention", description: "Insert a file path into your prompt" },
  { name: "ps", description: "Open this workspace's shells" },
  { name: "stop", description: "Stop Codex background terminals in this thread" },
  { name: "theme", description: "Choose System, Dark, or Light appearance" },
  { name: "help", description: "Show slash-command help" },
  { name: "quit", description: "Return to Workbench home; running work continues" },
  { name: "exit", description: "Return to Workbench home; running work continues" },
  { name: "ide", description: "Include IDE context", unavailable: "Requires a connected Codex IDE extension." },
  {
    name: "keymap",
    description: "Customize terminal key bindings",
    unavailable: "Terminal key bindings are configured in the Codex CLI.",
  },
  { name: "vim", description: "Toggle terminal Vim editing", unavailable: "Vim editing is a Codex terminal feature." },
  {
    name: "setup-default-sandbox",
    description: "Configure the Windows sandbox",
    unavailable: "This is a Windows-only CLI command. This devbox runs Linux.",
  },
  {
    name: "sandbox-add-read-dir",
    description: "Add Windows sandbox read access",
    unavailable: "This is a Windows-only CLI command.",
  },
  {
    name: "agent",
    description: "Switch to a Codex subagent thread",
    unavailable: "Subagent thread switching is not available in Workbench. Use Codex's native agent picker.",
  },
  {
    name: "subagents",
    description: "Switch to a Codex subagent thread",
    unavailable: "Subagent thread switching is not available in Workbench. Use Codex's native agent picker.",
  },
  {
    name: "archive",
    description: "Archive a Codex session",
    unavailable:
      "Workbench does not archive individual conversations. Use the tab X to delete one, or archive the workspace.",
  },
  {
    name: "experimental",
    description: "Configure experimental Codex features",
    unavailable: "Manage experimental features in Codex's native settings on the devbox.",
  },
  {
    name: "approve",
    description: "Retry an automatic-review denial",
    unavailable:
      "Automatic-review retry controls are not integrated with Workbench. Use the native Codex approval controls.",
  },
  {
    name: "memories",
    description: "Configure Codex memory",
    unavailable: "Memory settings are managed by Codex's native configuration on the devbox.",
  },
  {
    name: "import",
    description: "Import another agent's setup",
    unavailable: "Run the Codex import workflow on the devbox.",
  },
  {
    name: "feedback",
    description: "Send Codex feedback and logs",
    unavailable: "Send diagnostics through Codex's native feedback dialog on the devbox.",
  },
  {
    name: "logout",
    description: "Sign out of the Codex account",
    unavailable: "Codex credentials are managed on the devbox. Workbench sign-out is available in Settings.",
  },
  {
    name: "goal",
    description: "Manage a persistent Codex goal",
    unavailable:
      "Automatic goal continuations are not integrated with Workbench's run tracking. Use Codex's native goal controls.",
  },
  {
    name: "personality",
    description: "Choose a communication style",
    unavailable: "The installed Codex protocol no longer supports personality selection.",
  },
  {
    name: "app",
    description: "Continue in the desktop app",
    unavailable: "Use Codex's native remote connection to continue in the desktop app.",
  },
  {
    name: "side",
    description: "Start a temporary side chat",
    unavailable: "Temporary side chats are not available here. Use /new for a separate conversation.",
  },
  {
    name: "btw",
    description: "Start a temporary side chat",
    unavailable: "Temporary side chats are not available here. Use /new for a separate conversation.",
  },
  {
    name: "raw",
    description: "Toggle terminal raw scrollback",
    unavailable: "Raw scrollback is a terminal display option. Use /copy for the latest response.",
  },
  {
    name: "debug-config",
    description: "Inspect Codex config diagnostics",
    unavailable: "Use Codex's native configuration diagnostics on the devbox.",
  },
  {
    name: "statusline",
    description: "Configure the terminal status line",
    unavailable: "Terminal status-line settings are configured in the Codex CLI.",
  },
  {
    name: "title",
    description: "Configure terminal title fields",
    unavailable: "Terminal title settings are configured in the Codex CLI. Use /rename to name this conversation.",
  },
  { name: "pets", description: "Choose a terminal pet", unavailable: "Terminal pets are configured in the Codex CLI." },
  { name: "pet", description: "Choose a terminal pet", unavailable: "Terminal pets are configured in the Codex CLI." },
] as const;

export type SlashCommand = (typeof SLASH_COMMANDS)[number];
export function parseSlash(text: string) {
  const match = /^\/([a-z-]*)(?:\s+([\s\S]*))?$/i.exec(text.trimStart());
  return match ? { query: match[1]!.toLowerCase(), args: match[2] ?? "" } : null;
}
