# Changelog

## Unreleased

- `ROADMAP.md`: build timeline, feature completeness against the brief (8 of 8) and the full plan (24 of 45), and the release plan to 1.0. Summarised in a new README Status section.
- `npm run demo`: a narrated MCP client session (shell, cursor reads, prompts, a REPL, a web server, kill), recorded in `docs/demo.gif`, plus `docs/demo-manus.md`, the transcript of a Manus task controlling terminals through the published package.

## 0.1.0

First release.

- Six MCP tools: `terminal_start`, `terminal_exec`, `terminal_write`, `terminal_read`, `terminal_list`, `terminal_kill`.
- Real pseudo-terminals (node-pty) with a headless xterm screen, so full-screen programs, colours and prompts render as a user would see them.
- Command tracking in bash and zsh through VS Code's shell-integration scripts: exact output, exit code and working directory per command, and busy, idle, waiting-for-input and exited states.
- Output journal with absolute cursors, so agents can keep reading long-running output without missing or repeating lines.
- Interactive input: text, named keys (`ctrl+c`, arrows, function keys) and waits for a pattern, the prompt or the end of a command.
- stdio for local clients; Streamable HTTP with bearer-token auth, Host and Origin checks, and an optional secret-path token for URL-only clients such as Manus. Serves both the 2025 protocol and the 2026-07-28 revision.
- Limits, idle timeout, process-tree kill, a JSONL audit log, and agent commands kept out of your shell history.
- Questions a shell asks while starting (such as zsh's compinit "insecure directories" check) are reported by `terminal_start` as `awaiting_input` with the question; once answered, the session is tracked normally.
- `terminal_start` for a program waits for its first output, then for 300 ms of quiet, so slow starters (python on a busy machine) are reported once their prompt is up.
- Requires Node.js 22.12 or later (Node 20 is end-of-life, and the `commander` dependency needs 22.12).
- macOS: repairs node-pty 1.1.0's non-executable `spawn-helper`, and sends multi-line commands to `/bin/bash` 3.2 (no bracketed paste) as a single `eval` line.
