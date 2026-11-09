# Vendored VS Code shell integration

These files are unmodified copies of Microsoft's VS Code terminal shell-integration scripts (MIT, see
`THIRD_PARTY_NOTICES.md`), taken from `microsoft/vscode` at commit `3b3b6374cbab9edd5c6e9c965347bb7e1277a06a` (2026-10-15), path
`src/vs/workbench/contrib/terminal/common/scripts/`.

terminal-mcp launches them the same way VS Code does (bash: `--init-file`, via the small wrapper
`../terminal-mcp-bash.sh` that sources the script and then turns history off for agent shells; zsh: a
private `ZDOTDIR` whose startup files chain to the user's own). They emit `OSC 633` marks that the server parses with
`@xterm/headless`: `A`/`B` prompt start/end, `E` command line, `C` command output start,
`D;<exit>` command finished, `P;Cwd=<dir>` working directory.

To update: copy the same files from a newer VS Code commit, update the hash above, and run `npm test`.
The fish and PowerShell scripts are vendored for the next phase and are not used yet.
