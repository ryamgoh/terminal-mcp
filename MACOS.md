# Running and testing terminal-mcp on macOS

This guide takes you from the zip file to a working server on your Mac in about fifteen minutes. You install it, run the test suite, watch a live session, poke at it in the MCP Inspector, connect a local agent, and optionally expose it to Manus over HTTPS. Every command below runs in Terminal (or iTerm) from the project folder unless it says otherwise.

## 1. Prerequisites

macOS already ships most of what the server needs: zsh 5.9 (the default login shell), `/bin/bash` 3.2, `vim`, `stty` and `pgrep`. You need to add Node.js and, for two of the tests, Python.

| You need | Check | Install if missing |
|---|---|---|
| Node.js 22.12+ or 24 (LTS) | `node -v` | `brew install node@22`, or nvm / fnm |
| Xcode Command Line Tools (provides `python3`, used by the REPL and password tests) | `xcode-select -p` | `xcode-select --install` |
| Homebrew (optional, for ngrok in step 8) | `brew -v` | see brew.sh |

No C++ compiler is needed: `node-pty` ships prebuilt binaries for Apple silicon and Intel Macs.

## 2. Unpack and install

Put the project somewhere permanent first, because MCP clients will store its absolute path.

```bash
mkdir -p ~/Developer && cd ~/Developer
unzip ~/Downloads/terminal-mcp-mvp.zip
cd terminal-mcp
npm install
```

During install you should see these two lines:

```
terminal-mcp: made node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper executable (node-pty#850)
terminal-mcp: made node_modules/node-pty/prebuilds/darwin-x64/spawn-helper executable (node-pty#850)
```

They are expected. node-pty 1.1.0, the current stable release, publishes its macOS helper binary without the execute bit, which makes every terminal spawn fail with `posix_spawnp failed` ([microsoft/node-pty#850](https://github.com/microsoft/node-pty/issues/850)). The project's `postinstall` restores the bit, and the server checks again at startup in case scripts were skipped.

## 3. Run the test suite

```bash
npm test
```

This builds the server and runs 91 end-to-end tests against the real binary through the official MCP client, in about a minute. The shell scenarios run four times (stdio with a 2025-era client and HTTP with a 2026-07-28 client, each on bash and zsh). The rest cover the python REPL, vim, screen rendering, output floods, paging, ten concurrent sessions, limits, disconnect cleanup and HTTP security. The run should end with:

```
 Test Files  2 passed (2)
      Tests  91 passed (91)
```

The tests use whichever `bash` comes first on your `PATH`. If you installed bash 5 with Homebrew, that is the one tested. To test macOS's own `/bin/bash` 3.2 as well:

```bash
mkdir -p /tmp/sysbash && ln -sf /bin/bash /tmp/sysbash/bash
PATH=/tmp/sysbash:$PATH npx vitest run test/shell.test.ts -t bash     # expect: 34 passed
```

bash 3.2 has no bracketed paste, so for it the server sends a multi-line command as a single `eval $'…'` line. Heredocs, `cd` and `export` still behave exactly as if typed.

If a dialog asks to install the command line developer tools when the tests start, `python3` is the macOS stub; install the tools (step 1) and rerun.

## 4. Watch one session end to end

```bash
npm run smoke                    # your login shell (zsh on a default Mac)
npm run smoke -- --shell bash    # the first bash on PATH
```

The smoke check starts the server over stdio exactly as Claude Code or Cursor would, then drives one session through the main features and prints each result:

```
PASS  1. Server answers over stdio and lists its tools
PASS  2. Start a tracked shell
PASS  3. Run a command and get only its output
PASS  4. Shell state persists between calls
PASS  5. Failures come back with their exit code
PASS  6. Multi-line commands and heredocs
PASS  7. Long command returns early, then the agent waits for the end
PASS  8. Interactive input: detect the prompt, answer it
PASS  9. Ctrl+C interrupts a running command
PASS  10. List sessions with their state
PASS  11. Kill the session and its process tree

All 11 checks passed.
```

Each line is followed by the detail behind it, such as the command output, the exit code, the working directory or the session state.

## 5. Explore it by hand in the MCP Inspector

```bash
npm run inspect
```

Your browser opens the Inspector at `http://127.0.0.1:6274` (the access token is already in the URL). The connection is prefilled with the stdio command for this server. Click **Connect**, open the **Tools** tab and click **List Tools**. Then try this sequence:

1. Run `terminal_start` with no arguments and copy the `session_id` from the result.
2. Run `terminal_exec` with that `session_id` and `command` set to `ls -la ~`.
3. Run `terminal_exec` with `command` set to `sleep 5; echo done` and `timeout_ms` set to `1000`. The result says `completed: false` and gives a `cursor`.
4. Run `terminal_read` with that `cursor` and `wait_for` set to `command_end`. It returns `done` and the exit code.
5. Run `terminal_kill` to end the session.

Press Ctrl+C in Terminal to stop the Inspector.

## 6. Use it from a local agent

All three clients launch the server themselves over stdio, so nothing needs to be running beforehand. Get the two absolute paths first:

```bash
which node              # e.g. /opt/homebrew/bin/node
echo "$PWD/dist/cli.js" # e.g. /Users/you/Developer/terminal-mcp/dist/cli.js
```

**Claude Code.** From the project folder:

```bash
claude mcp add terminal -- node "$PWD/dist/cli.js"
claude mcp list         # terminal should show as connected
```

**Cursor.** Add this to `~/.cursor/mcp.json`, then check that the server shows as enabled in Cursor's MCP settings:

```json
{
  "mcpServers": {
    "terminal": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/you/Developer/terminal-mcp/dist/cli.js"]
    }
  }
}
```

**Claude Desktop.** Put the same block in `~/Library/Application Support/Claude/claude_desktop_config.json` and quit and reopen the app (Cmd+Q, not just closing the window). If it does not connect, the server's stderr is in `~/Library/Logs/Claude/`.

Use the absolute `node` path from `which node` for the desktop apps. They do not load your shell's `PATH`, so a plain `node` from nvm, fnm or Homebrew may not be found.

To try it, ask the agent something like: *"Use the terminal tools to start a shell in ~/Developer/terminal-mcp, run npm test, and tell me the result. Then start python3, compute 6*7 in it, and close the session."*

Two macOS behaviours to expect. Sessions are login shells by default, so your `~/.zprofile` (for example Homebrew's `shellenv`) and `~/.zshrc` load as in a new Terminal window. And the first time an agent's command touches Desktop, Documents or Downloads, macOS asks for permission on behalf of the app that launched the server (Claude, Cursor or Terminal).

Every tool call is logged to `~/.terminal-mcp/audit.jsonl`.

## 7. Try HTTP mode locally

Remote clients use HTTP mode, and you can test it on your own machine before involving a tunnel.

```bash
node dist/cli.js --http --port 8765
```

On first start it prints:

```
terminal-mcp: generated a bearer token and saved it to /Users/you/.terminal-mcp/token
responseMode: 'json' drops mid-call notifications. ...
terminal-mcp 0.1.0 listening on http://127.0.0.1:8765/mcp (auth: bearer token, localhost only)
```

The middle line is an informational message from the MCP SDK about plain-JSON responses, which this server uses on purpose. In a second Terminal tab:

```bash
curl -s http://127.0.0.1:8765/healthz
# {"ok":true,"name":"terminal-mcp","version":"0.1.0"}

curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8765/mcp -H 'content-type: application/json' -d '{}'
# 401   (no token)

npx tsx test/remote-check.ts http://127.0.0.1:8765/mcp "$(cat ~/.terminal-mcp/token)"
# [legacy client, protocol 2025-11-25] start=idle exec="hi from <your-mac> in /tmp" exit=0 ... kill -> exited
# [auto client, protocol 2026-07-28] start=idle exec="hi from <your-mac> in /tmp" exit=0 ... kill -> exited
```

The last command runs a full workflow (start, exec, cd, a long command followed up by cursor, kill) with both protocol generations over HTTP. Stop the server with Ctrl+C.

## 8. Connect Manus to your Mac (optional)

Manus runs in the cloud, so it needs an HTTPS URL that reaches your Mac. ngrok with a free static domain is the simplest option.

```bash
brew install ngrok
ngrok config add-authtoken <your-ngrok-authtoken>     # from the ngrok dashboard
# claim your free static domain in the dashboard, e.g. your-name.ngrok-free.dev
```

Terminal tab 1 (`caffeinate -i` keeps the Mac from sleeping while it serves):

```bash
caffeinate -i node dist/cli.js --http --port 8765 --allowed-host your-name.ngrok-free.dev --url-token
```

Terminal tab 2:

```bash
ngrok http 8765 --url your-name.ngrok-free.dev
```

Check the public path from tab 3 before touching Manus:

```bash
npx tsx test/remote-check.ts https://your-name.ngrok-free.dev/mcp "$(cat ~/.terminal-mcp/token)"
```

Then add a custom MCP connector in Manus. If the option you use takes only a URL, use `https://your-name.ngrok-free.dev/mcp/<token>` (this is what `--url-token` enables). If it lets you set headers, use `https://your-name.ngrok-free.dev/mcp` with `Authorization: Bearer <token>`. Print the token with `cat ~/.terminal-mcp/token`. A `403` means the hostname is missing from `--allowed-host`; a `401` means the token is wrong.

Anyone with the URL and token gets a shell as your user, so stop both tabs with Ctrl+C when you are done. To rotate the token, delete `~/.terminal-mcp/token` and restart; a new one is generated.

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Error: posix_spawnp failed` | node-pty's `spawn-helper` is not executable (install ran with `--ignore-scripts`, or with pnpm) | Start the server once (it repairs this on start), or run `chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper` |
| Client says the server failed to start, or `spawn node ENOENT` | The desktop app cannot find `node` | Use the absolute path from `which node` as `command` |
| `terminal_start` returns `awaiting_input: true` and the screen says `zsh compinit: insecure directories` | Your zsh completion setup found group- or world-writable directories (common with Homebrew under `/opt/homebrew/share`) and asks before every new shell | The agent can answer it (`n` is the safe answer) and the session then works normally. To stop the question for good, run `compaudit \| xargs chmod g-w,o-w` in your own terminal |
| `terminal_start` returns `integration: "none"` | Your startup files disable or break VS Code's shell integration (some prompt frameworks do) | Try `terminal_start` with `"shell": "bash"`; `terminal_write` and `terminal_read` keep working regardless |
| Shell start is slow or hits `wait_ms` | A heavy `~/.zshrc` (for example a large plugin framework) | Pass a larger `wait_ms` to `terminal_start`, or `"login": false` |
| Developer-tools dialog during `npm test` | `/usr/bin/python3` is a stub until the Command Line Tools are installed | `xcode-select --install`, then rerun |
| `EADDRINUSE` | Port 8765 is taken | Add `--port 8766` (and use the same port for ngrok) |
| `403` or `401` over the tunnel | Hostname not allowed, or wrong token | See step 8 |
