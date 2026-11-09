# terminal-mcp bash init file (used with `bash --init-file`).
# Loads Microsoft's VS Code shell integration exactly as VS Code does (it also sources the user's
# ~/.bashrc, or the login profile files when VSCODE_SHELL_LOGIN=1), then applies agent fixups.
builtin source "${BASH_SOURCE[0]%/*}/vscode/shellIntegration-bash.sh"

# Keep agent commands out of the user's history. A leading space alone is not enough in bash:
# the second and later lines of a multi-line command would still be recorded and saved.
if [ "${TERMINAL_MCP_NO_HISTORY:-}" = "1" ]; then
	builtin set +o history
	# With history off, VS Code must take the command line from $BASH_COMMAND, not `history 1`.
	__vsc_history_verify=0
fi
builtin unset TERMINAL_MCP_NO_HISTORY
