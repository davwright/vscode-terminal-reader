#!/bin/bash
# vscode-terminal-reader-hook: name=block-python version=1
# Block Python invocations from the Bash tool.
# Python is not installed on this Windows machine. Claude defaults to it
# anyway; the model documentation alone doesn't survive long sessions.
# This hook stops the bad call at the tool layer and redirects.
#
# Matches as a leading word, optionally prefixed by env-var assignments
# (FOO=bar python ...) and `&&` / `;` / `|` chains. Won't match
# substrings like `pythonic`, `mypython`, or paths that contain `python`
# as a directory component. Won't match `node -e '... python ...'` etc.

INPUT=$(cat)

# Auto-install jq if missing — match block-git-write.sh's pattern.
if ! command -v jq &>/dev/null; then
  echo "jq not found — installing via winget..." >&2
  winget install --id jqlang.jq --accept-source-agreements --accept-package-agreements --silent 2>&1 >&2
  export PATH="$PATH:/c/ProgramData/chocolatey/bin:/c/Users/$USER/AppData/Local/Microsoft/WinGet/Links:/c/Users/$USER/bin"
  if ! command -v jq &>/dev/null; then
    echo "BLOCKED: jq install failed — block-python hook cannot parse input." >&2
    exit 2
  fi
fi

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty') || { echo "BLOCKED: failed to parse hook input." >&2; exit 2; }
[ -z "$COMMAND" ] && exit 0

# Statement-leading position: start of line, after `&&`/`||`/`;`/`|`/`(`,
# or after one or more `KEY=value` assignments. Then the executable token
# we don't want, then a non-word boundary.
#
# Matched executables:
#   python, python3, py             - interpreter
#   pip, pip3                       - package manager
#   python.exe, python3.exe, py.exe - explicit-extension forms
#   pipx, poetry, uv                - common Python tooling that pulls Python
#
# Justified by: user has no Python toolchain installed; any of these
# resolves to "command not found" or worse, an unexpected install via
# the Windows store stub.
PATTERN='(^|[[:space:]]*(&&|\|\||;|\|)[[:space:]]*|^([[:space:]]*[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)+)(python3?|py|pip3?|pipx|poetry|uv)(\.exe)?([[:space:]]|$)'

if echo "$COMMAND" | grep -qE "$PATTERN"; then
  cat <<'EOF' >&2
BLOCKED: Python toolchain is not installed on this machine.

You reached for python/pip/poetry/uv. None of these are available here.
Solve the problem in:
  - PowerShell 5.1 (powershell.exe -NoProfile -ExecutionPolicy Bypass -File <script.ps1>)
  - Node.js (node, npm, npx — all available)

If you genuinely need Python, ask the user before installing anything.
EOF
  exit 2
fi

exit 0
