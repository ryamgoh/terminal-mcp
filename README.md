# terminal-mcp

An MCP server that gives agents real terminals. A client can start shells or programs in a pseudo-terminal, run commands and get back exactly their output and exit code, keep reading output of long-running processes by cursor, type into interactive programs (REPLs, prompts, vim), see whether a session is busy, idle, waiting for input or exited, and terminate a session with its whole process tree.

It works with any MCP client. Local clients launch it over **stdio**; remote or hosted clients (such as Manus) connect over **Streamable HTTP** with a bearer token. It serves both the 2025-era protocol and the 2026-07-28 revision.

## Install from npm

No clone or build needed; the client starts the server with `npx`:

```bash
claude mcp add terminal -- npx -y @ryamgoh/terminal-mcp          # Claude Code
```

```json
{ "mcpServers": { "terminal": { "command": "npx", "args": ["-y", "@ryamgoh/terminal-mcp"] } } }
```

The JSON form works for Cursor (`~/.cursor/mcp.json`), Claude Desktop and most other clients. Add server flags after the package name, for example `["-y", "@ryamgoh/terminal-mcp", "--max-sessions", "8"]`. In Manus, a command-based custom MCP connector with `npx -y @ryamgoh/terminal-mcp` gives the agent terminals in its own cloud sandbox; to give it terminals on your machine, use HTTP mode (below). The server is also listed in the [MCP Registry](https://registry.modelcontextprotocol.io/) as `io.github.ryamgoh/terminal-mcp`.

## Quick start (from source)

```bash
npm install
npm run build
npm test            # 91 end-to-end tests against the built server (bash + zsh, stdio + HTTP)
npm run smoke       # narrated 11-step check of one real session, as a local MCP client sees it
```

Requirements: Node.js 22.12+ (CI tests 22 and 24), macOS or Linux, bash or zsh. `node-pty` ships prebuilt binaries for macOS; on Linux it compiles during install (needs `python3`, `make`, a C++ compiler). On macOS, install (and server start) restores the execute bit that node-pty 1.1.0 omits on its prebuilt `spawn-helper` ([node-pty#850](https://github.com/microsoft/node-pty/issues/850)); without it every spawn fails with `posix_spawnp failed`.

**On a Mac?** [MACOS.md](MACOS.md) walks through install, tests, the Inspector, connecting Claude Code, Cursor and Claude Desktop, HTTP mode and Manus, step by step.

**Releasing?** [PUBLISHING.md](PUBLISHING.md) covers the first release to npm and the MCP Registry, and the tag-driven releases after it.

## Connect a client

**Claude Code**

```bash
claude mcp add terminal -- node /absolute/path/to/terminal-mcp/dist/cli.js
```

**Cursor, Claude Desktop and other JSON-configured clients** (`~/.cursor/mcp.json`, `claude_desktop_config.json`, ...)

```json
{
  "mcpServers": {
    "terminal": { "command": "node", "args": ["/absolute/path/to/terminal-mcp/dist/cli.js"] }
  }
}
```

Desktop apps on macOS do not load your shell's `PATH`; if `node` comes from nvm, fnm or Homebrew and the server does not start, use the absolute path from `which node` as `command`.

**MCP Inspector** (interactive testing)

```bash
npm run inspect     # same as: npx @modelcontextprotocol/inspector node dist/cli.js
```

**Manus or any remote client (HTTP)**. A hosted client cannot start a process on your machine, so run the server in HTTP mode and expose it with a tunnel:

```bash
node dist/cli.js --http --port 8765 --allowed-host your-name.ngrok-free.dev
# prints where the generated bearer token is stored (~/.terminal-mcp/token), or pass --token / TERMINAL_MCP_TOKEN
ngrok http 8765 --url your-name.ngrok-free.dev
```

In Manus, add a custom MCP connector with the HTTPS URL `https://your-name.ngrok-free.dev/mcp` and the header `Authorization: Bearer <token>`. If a client can only take a URL (no headers), start the server with `--url-token` and use `https://your-name.ngrok-free.dev/mcp/<token>`. The server answers in plain JSON (no SSE streams), so it also works through tunnels that do not support streaming, such as Cloudflare quick tunnels. A `403` means the tunnel's hostname is missing from `--allowed-host`.

Manus can also launch the server itself in its cloud sandbox through a command-based connector (`node .../dist/cli.js`). The terminals then belong to that sandbox, not to your computer.

## Tools

| Tool | What it does |
|---|---|
| `terminal_start` | Start a session. Without `command`: your login shell (zsh/bash) with command tracking. With `command` + `args`: any program in a PTY (python, vim, ssh, a dev server). Returns `session_id`, state and the first screen. |
| `terminal_exec` | Run one command line in a shell session and wait (default 20 s) for it to finish. Returns only that command's output, `exit_code` and the new `cwd`. If it is still running at the timeout it keeps running and you get `completed: false` plus a `cursor`. |
| `terminal_write` | Type text (`input`) and/or named `keys` (`enter`, `ctrl+c`, `up`, `escape`, `f1`...). Waits until output settles or `until` matches and returns the new output. `paste: true` sends multi-line text as a bracketed paste. |
| `terminal_read` | Read without sending input. `cursor` returns only newer output and a `next_cursor`; `wait_for` can block for `output`, `command_end` (returns the finished command's clean output and exit code) or `exit`; `until` waits for a regex; `view: "screen"` returns the rendered screen for full-screen programs. |
| `terminal_list` | All sessions with state, exit code, busy/idle, current command, cwd and cursor. |
| `terminal_kill` | Terminate a session and its whole process tree (SIGHUP, then SIGKILL after `escalate_after_ms`). |

Every response includes the session's state: `state` (`running`/`exited`), `exit_code`, `shell_state` (`idle`/`busy`), `current_command`, `cwd`, `cursor`, and `awaiting_input` with `input_kind` (`password` when the program turned terminal echo off, `prompt` when the cursor sits after prompt-like text). Errors explain what to do next, for example how to interrupt a busy shell. Results carry both `structuredContent` and a text block with the output as plain text.

Typical agent loops:

```text
terminal_start {}                                        -> session_id, shell_state: idle
terminal_exec  {session_id, command: "npm test"}         -> exit_code 1, output: failing test
terminal_exec  {session_id, command: "npm run dev", timeout_ms: 3000}
                                                         -> completed: false, cursor: 18233
terminal_read  {session_id, cursor: 18233, until: "ready on"}   -> matched, next_cursor
terminal_write {session_id, keys: ["ctrl+c"]}            -> dev server stopped, exit 130
```

## What does the work (libraries, not custom code)

The server is a thin, tested layer of glue (about 1,500 lines of TypeScript) over existing libraries and standards.

| Concern | Provided by |
|---|---|
| MCP protocol, both protocol eras, stdio and Streamable HTTP | `@modelcontextprotocol/server` (`serveStdio`, `createMcpHandler`), `@modelcontextprotocol/node` |
| HTTP app, Host/Origin validation (DNS-rebinding protection), bearer auth with `WWW-Authenticate` | `@modelcontextprotocol/express` (`createMcpExpressApp`, `requireBearerAuth`) on Express 5 |
| Pseudo-terminals, resize, signals | `node-pty` (Microsoft, used by VS Code) |
| Terminal emulation: rendering `\r` progress bars, cursor movement, colours, the visible screen, alternate screen, scrollback markers, bracketed-paste and cursor-key modes | `@xterm/headless` (xterm.js) |
| Command start/end, exit codes, command line, cwd | VS Code's shell-integration scripts (vendored unmodified, MIT) emitting `OSC 633` marks, parsed by xterm's `registerOscHandler`; bash loads them through a 13-line wrapper (`shell-integration/terminal-mcp-bash.sh`) that also turns history off |
| Multi-line commands | Bracketed paste, detected with xterm's `modes` and a `registerCsiHandler` hook; bash without it (macOS's `/bin/bash` 3.2) gets the lines as one `eval $'…'` line |
| Key names to escape sequences | `SPECIAL_KEYS` table from `pty-manager` (vendored, MIT); application-cursor mode from xterm |
| Password-prompt detection | the OS's own `stty` (echo off + canonical mode is what `getpass`, `sudo` and `ssh` set) |
| Killing the whole process tree | `tree-kill` |
| Input validation and JSON Schema for tools | `zod` 4 |
| Audit log and diagnostics | `pino` (JSONL to `~/.terminal-mcp/audit.jsonl`, diagnostics to stderr) |
| CLI | `commander` |

What is ours: the session model (state machine and waits), the output journal with absolute cursors and loss reporting, tool contracts and error messages, and lifecycle and limits.

## Security model

The server runs commands as your user, with your permissions; treat any connected client as having a shell on your machine.

Over stdio, the client that launched the server is the only party that can talk to it. Over HTTP, the server binds to `127.0.0.1` by default and requires a bearer token (constant-time comparison), validates `Host` (DNS-rebinding protection) and rejects foreign browser `Origin`s. It refuses `--no-auth` on non-loopback addresses. Child processes do not inherit `TERMINAL_MCP_*` variables, so the token never reaches the shell.

Agent commands are kept out of your shell history by default (bash: history is off in agent shells; zsh: `HIST_IGNORE_SPACE` with a leading space; `--keep-history` to change). Every tool call is appended to the audit log (inputs truncated at 2,000 characters). Limits: 16 running sessions, 2 MB of retained output per session, 10,000 lines of scrollback, a 60 s cap on any blocking wait, and sessions untouched for 60 minutes are killed (`--max-sessions`, `--max-wait`, `--idle-timeout`). When the stdio client disconnects or the server receives SIGINT/SIGTERM/SIGHUP, every session and its children are terminated.

## Options

```text
--http                     serve Streamable HTTP instead of stdio
--host <addr>              HTTP bind address (default 127.0.0.1)
--port <n>                 HTTP port (default 8765; 0 = pick a free port)
--allowed-host <name...>   extra Host header names to accept (your tunnel hostname)
--allowed-origin <name...> Origin hostnames to accept from browser-based clients
--allow-any-host           accept any Host header (token still required)
--token <token>            bearer token (or TERMINAL_MCP_TOKEN; default: generated, saved to ~/.terminal-mcp/token)
--url-token                also accept the token as a secret path /mcp/<token>
--no-auth                  disable auth (loopback binds only)
--max-sessions <n>         maximum running sessions (default 16)
--idle-timeout <minutes>   kill sessions untouched this long; 0 disables (default 60)
--max-wait <seconds>       cap on any blocking wait in a tool call (default 60)
--audit-log <file>         audit log path (default ~/.terminal-mcp/audit.jsonl)
--no-audit                 disable the audit log
--keep-history             let agent commands into your shell history
```

## Testing

`npm test` builds the server and runs the end-to-end suite with the official MCP client against the real binary: the shell scenarios run four times (stdio with a 2025-era client and HTTP with a 2026-07-28 client, each on bash and zsh), plus programs (python REPL, vim), screen rendering, output floods, paging, ten concurrent sessions, limits, disconnect cleanup and HTTP security. `npm run smoke` drives one session through the main features and prints each step. `npm run inspect` opens the MCP Inspector UI on the server. To test with macOS's own `/bin/bash` 3.2 when a newer Homebrew bash comes first on `PATH`, see [MACOS.md](MACOS.md). `npx tsx test/bench.ts` prints exec latency and wait-budget overruns; `npx tsx test/remote-check.ts <url> <token>` drives a deployed server through a public URL. CI runs on Linux and macOS (`.github/workflows/ci.yml`).

## Known limitations

Windows is not supported yet (node-pty supports ConPTY; the shell integration for PowerShell is vendored but not wired up). Shells other than bash and zsh fall back to bash. Sessions live in the server process and do not survive a restart. Commands that replace the shell (`exec`), or shells whose startup files disable VS Code's integration, lose command tracking; `terminal_write` and `terminal_read` still work. If a shell asks a question while it starts (for example zsh's compinit "insecure directories" check, or a prompt in `~/.zshrc`), `terminal_start` returns `awaiting_input: true` with the question in `hint`; answering it with `terminal_write` lets the shell finish starting, and command tracking begins at its first prompt.
