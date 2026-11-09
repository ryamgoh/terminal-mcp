# Demo: Manus controlling terminals through terminal-mcp

This is a real session, recorded on 2026-11-09. terminal-mcp was added to a Manus account as a custom MCP connector that runs the published package, and the Manus agent then called its tools directly through Manus's own MCP client:

```json
{ "mcpServers": { "terminal-mcp": { "command": "npx", "args": ["-y", "@ryamgoh/terminal-mcp"] } } }
```

Responses below are trimmed to the relevant fields; the output text is verbatim.

## 1. Create three sessions

```text
→ terminal_start {"name":"work","shell":"bash","cwd":"/tmp"}
← state: running, integration: vscode-osc633, shell_state: idle, reason: ready
  screen: ubuntu@9c15afd0c3d9:/tmp$

→ terminal_start {"name":"py","command":"python3","args":["-q"]}
← state: running, reason: settled, awaiting_input: true, input_kind: prompt
  screen: >>>

→ terminal_start {"name":"web","command":"python3","args":["-u","-m","http.server","8799","--bind","127.0.0.1"],"cwd":"/tmp"}
← state: running, reason: settled
  screen: Serving HTTP on 127.0.0.1 port 8799 (http://127.0.0.1:8799/) ...
```

## 2. Run a command: output, exit code, cwd

```text
→ terminal_exec {"session_id":"work","command":"mkdir -p manus-demo && cd manus-demo && echo \"host=$(hostname) node=$(node -v)\"; ...; ls /no/such/dir"}
← completed: true, exit_code: 2, cwd: /tmp/manus-demo, duration_ms: 11
  host=9c15afd0c3d9 node=v22.23.4
  same machine as the task
  ls: cannot access '/no/such/dir': No such file or directory
```

## 3. A long-running command: return early, keep reading

```text
→ terminal_exec {"session_id":"work","command":"for i in 1 2 3 4 5 6; do echo \"build step $i/6\"; sleep 1; done; echo done","timeout_ms":2000}
← completed: false, reason: timeout, shell_state: busy, cursor: 856
  build step 1/6
  build step 2/6
  hint: Still running. Poll with terminal_read {cursor, wait_for:"command_end"}, or interrupt with terminal_write {keys:["ctrl+c"]}.

→ terminal_read {"session_id":"work","cursor":856,"wait_for":"command_end"}
← next_cursor: 1092, output_lost: false, last_command: {exit_code: 0, duration_ms: 6010}
  build step 3/6
  build step 4/6
  build step 5/6
  build step 6/6
  done
```

Reading from the cursor returned exactly the output that had not been seen yet.

## 4. Write to interactive processes

```text
→ terminal_exec {"session_id":"work","command":"read -r -p 'Deploy to production? [y/N] ' answer; echo \"you said: ${answer:-nothing}\"","timeout_ms":1500}
← completed: false, shell_state: busy, awaiting_input: true, input_kind: prompt
  Deploy to production? [y/N]

→ terminal_write {"session_id":"work","input":"n\r"}
← shell_state: idle, last_command: {exit_code: 0}
  you said: n

→ terminal_write {"session_id":"py","input":"import math; big = math.factorial(20)\r"}
→ terminal_write {"session_id":"py","input":"print(big, len(str(big)))\r"}
← 2432902008176640000 19
  >>>
```

The REPL kept `big` between calls.

## 5. A dev server in one session, a client in another

```text
→ terminal_exec {"session_id":"work","command":"curl -s -o /dev/null -w 'HTTP %{http_code}\\n' http://127.0.0.1:8799/manus-demo/"}
← exit_code: 0
  HTTP 200

→ terminal_read {"session_id":"web","cursor":66}
← 127.0.0.1 - - [09/Nov/2026 03:22:23] "GET /manus-demo/ HTTP/1.1" 200 -
```

## 6. Terminate, and check that it really stopped

```text
→ terminal_kill {"session_id":"web"}
← state: exited, exit_signal: SIGHUP
→ terminal_kill {"session_id":"py"}
← state: exited, exit_signal: SIGHUP

→ terminal_exec {"session_id":"work","command":"curl -s -o /dev/null -w 'HTTP %{http_code}\\n' --max-time 2 http://127.0.0.1:8799/; echo \"curl exit $?\"; pgrep -f 'http.server 8799' || echo 'no http.server process left'"}
← HTTP 000
  curl exit 7
  no http.server process left

→ terminal_kill {"session_id":"work"}
→ terminal_list {}
← work: exited, py: exited, web: exited
```

## Notes from this run

The terminals ran on the task's own cloud computer: the connector's shell saw the task's files, and the different hostname comes from the container namespace Manus starts MCP servers in. Two small issues showed up and are queued for 0.1.1: while a command is still running, its partial output starts with the echoed command line, and a session ended by a signal reports `exit_code: 0` next to `exit_signal` instead of no exit code.
