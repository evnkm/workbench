# 0003 Claude Agent SDK authentication

Status: **deferred** by the user on October 4, 2026 (Phase 0).

Claude Code `2.1.289` is installed, and `@anthropic-ai/claude-agent-sdk` `0.3.289` is the current npm release. Anthropic's documentation directs third-party integrations to API-key authentication. Reusing the personal Claude Code login on this machine is a billing and terms question, so it is not assumed.

## Decision

Codex is built end to end first. The Claude integration (Phase 4) stays pending until an `ANTHROPIC_API_KEY` is placed in the Workbench environment file (`~/.config/workbench/env`). Until then, the provider picker shows Claude as unavailable and explains why.

## Before Phase 4

- Run the equivalent of the Codex probes against the SDK: start, stream, `canUseTool` approval, `AskUserQuestion`, interrupt, resume by session id, and process crash.
- Verify that `settingSources` loads project `CLAUDE.md`, skills, and MCP configuration as intended. SDK defaults do not match an interactive CLI invocation.
- Record the authentication method and cost expectations in the setup guide.
