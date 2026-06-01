#!/bin/bash
# vscode-terminal-reader-hook: name=block-git-write version=1
# Block git commit/push unless targeting a whitelisted repo.
# Uses `git remote -v` push lines to identify the repo by its remote org.
#
# Whitelist patterns (matched case-insensitively against push URLs)
WHITELIST=(
  'github\.com'
  'dev\.azure\.com/evolx/'
)

# Blocked:
#   - Everything else (e.g. oebb-azure-platform@ customer repos)

INPUT=$(cat)

# Detect git commit/push/remote-mutation anywhere in the input. The middle
# group `([^[:space:]]+[[:space:]]+)*` in each pattern allows flag tokens
# like `-C <path>` or `--git-dir=<path>` between `git` and the subcommand.
# Leading/trailing `[^[:alnum:]_]` act as manual word boundaries so
# identifiers like `register_git_commit` don't false-match.
#
# Each entry in INTERCEPT_PATTERNS is one regex + one human-readable
# label. To extend (e.g. add `git filter-branch` or `git update-ref`),
# append a new (regex, label) pair. The label is used in the BLOCKED
# error message so the operator knows which rule fired.
#
# We police three families today:
#   1. commit / push                 - mutate history or upload it
#   2. remote add/remove/set-url/... - swap or remove the remote URL the
#                                       whitelist test reads. Plain
#                                       `git remote` / `git remote -v` /
#                                       `git remote show` / `git remote
#                                       get-url` (read-only) pass through.
#   3. config remote.*.url           - back-door equivalent of
#                                       `git remote set-url`. Two shapes:
#                                       (a) explicit write flag
#                                       (--add / --unset / --replace-all)
#                                       (b) `config remote.X.Y <value>`
#                                       where the trailing token is a
#                                       value (turns `--get` reads into
#                                       no-ops, since they have no value).
#
# Run on raw JSON so non-git Bash commands exit fast without needing jq.
INTERCEPT_PATTERNS=(
  'commit/push|(^|[^[:alnum:]_])git[[:space:]]+([^[:space:]]+[[:space:]]+)*(commit|push)([^[:alnum:]_]|$)'
  'remote-mutation|(^|[^[:alnum:]_])git[[:space:]]+([^[:space:]]+[[:space:]]+)*remote[[:space:]]+(add|remove|rm|rename|set-url|set-branches|set-head|prune)([^[:alnum:]_]|$)'
  'config-remote-write-flag|(^|[^[:alnum:]_])git[[:space:]]+([^[:space:]]+[[:space:]]+)*config[[:space:]]+([^[:space:]]+[[:space:]]+)*(--add|--unset|--unset-all|--replace-all)[[:space:]]+remote\.[^[:space:]]+\.(url|pushurl|fetch|push|mirror)([^[:alnum:]_]|$)'
  'config-remote-set|(^|[^[:alnum:]_])git[[:space:]]+([^[:space:]]+[[:space:]]+)*config[[:space:]]+([^[:space:]]+[[:space:]]+)*remote\.[^[:space:]]+\.(url|pushurl|fetch|push|mirror)[[:space:]]+[^[:space:]]'
)

# Did any pattern match? Capture the matched label too so the early-refuse
# branches below can quote it in the error.
MATCHED_LABEL=""
for entry in "${INTERCEPT_PATTERNS[@]}"; do
  label="${entry%%|*}"
  pattern="${entry#*|}"
  if echo "$INPUT" | grep -qE "$pattern"; then
    MATCHED_LABEL="$label"
    break
  fi
done
if [ -z "$MATCHED_LABEL" ]; then
  exit 0
fi

# Auto-install jq if missing, fail-closed if install fails
if ! command -v jq &>/dev/null; then
  echo "jq not found — installing via winget..." >&2
  winget install --id jqlang.jq --accept-source-agreements --accept-package-agreements --silent 2>&1 >&2
  # Add common install locations to PATH for this session
  export PATH="$PATH:/c/ProgramData/chocolatey/bin:/c/Users/$USER/AppData/Local/Microsoft/WinGet/Links:/c/Users/$USER/bin"
  if ! command -v jq &>/dev/null; then
    echo "BLOCKED: jq install failed — hook cannot parse input. Install jq manually or ask the user to commit manually." >&2
    exit 2
  fi
fi

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command') || { echo "BLOCKED: failed to parse hook input." >&2; exit 2; }
CWD=$(echo "$INPUT" | jq -r '.cwd // empty') || CWD=""

if [ -z "$COMMAND" ] || [ "$COMMAND" = "null" ]; then
  echo "BLOCKED: could not extract command from hook input." >&2
  exit 2
fi

# Refuse commands that redirect git at a different repo via env-var or
# flag. These bypass the CWD/-C target check below: the hook would happily
# read remotes from the whitelisted CWD while the actual commit lands in
# whatever repo GIT_DIR / --git-dir / --work-tree points at. Claude Code
# has no legitimate reason to use any of them.
#
# Strip single- and double-quoted substrings before scanning so commit
# messages can't false-trip (e.g. `git commit -m "documents --git-dir
# bypass attempts"`). Heredoc bodies (`<<EOF ... EOF`) are also stripped
# so meta-commits explaining what the hook blocks aren't blocked by their
# own message body. Anything outside a quoted/heredoc region is what a
# real shell would treat as command syntax - that's what we scan.
sanitized=$(printf '%s' "$COMMAND" \
  | sed -E ':a;N;$!ba; s/<<-?'"'"'?([A-Za-z_][A-Za-z0-9_]*)'"'"'?[^\n]*\n.*\n\1[[:space:]]*$//g' \
  | sed -E "s/'[^']*'//g; s/\"[^\"]*\"//g")

# Env-var prefix: in bash, FOO=bar at the start of a command (whether
# `FOO=bar cmd ...`, `export FOO=bar`, or after a separator) is an
# env-var assignment. Anywhere else, after stripping quoted strings,
# `FOO=bar` doesn't legitimately appear, so any GIT_DIR= sighting is
# treated as an attempt to redirect git.
if echo "$sanitized" | grep -qE '(^|[[:space:];&|])(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE)='; then
  echo "BLOCKED: git env-var override (GIT_DIR / GIT_WORK_TREE / ...) is not allowed - it bypasses the repo whitelist. Run the command without that env var, or commit manually." >&2
  exit 2
fi
# Bypass flags: must appear as a token (preceded by whitespace), not
# inside another arg. Stripping quotes above handles the message-body
# false-positive.
if echo "$sanitized" | grep -qE '(^|[[:space:]])--(git-dir|work-tree|namespace)(=|[[:space:]]|$)'; then
  echo "BLOCKED: git redirect flag (--git-dir / --work-tree / --namespace) is not allowed - it bypasses the repo whitelist. Use 'git -C <path>' instead, or commit manually." >&2
  exit 2
fi

# Refuse remote-mutation and remote-config-write outright (regardless of
# whether the current remote is whitelisted). The whitelist is read FROM
# the live remote URL, so swapping it would let any future push slip
# through. These have no automated use case in Claude Code - if a remote
# legitimately needs to change, the user does it by hand.
case "$MATCHED_LABEL" in
  remote-mutation)
    echo "BLOCKED: git remote mutation (add / remove / rm / rename / set-url / set-branches / set-head / prune) is not allowed - it would let a future push bypass the URL whitelist. Run the command manually if intended." >&2
    exit 2
    ;;
  config-remote-write-flag|config-remote-set)
    echo "BLOCKED: git config of remote.* is not allowed - it is the back-door equivalent of 'git remote set-url' and bypasses the URL whitelist. Run the command manually if intended." >&2
    exit 2
    ;;
esac

# Determine which directory the git command targets.
# Check for explicit cd or -C in the command, otherwise use cwd.
TARGET_DIR="$CWD"
CD_MATCH=$(echo "$COMMAND" | sed -n 's/.*cd[[:space:]]\+["'"'"']\?\([^"'"'"';&|]*[^"'"'"'[:space:];&|]\)["'"'"']\?.*/\1/p' | tail -1)
if [ -n "$CD_MATCH" ]; then
  TARGET_DIR="$CD_MATCH"
fi
GIT_C_MATCH=$(echo "$COMMAND" | sed -n 's/.*git[[:space:]]\+-C[[:space:]]\+["'"'"']\?\([^"'"'"'[:space:]]*\)["'"'"']\?.*/\1/p' | tail -1)
if [ -n "$GIT_C_MATCH" ]; then
  TARGET_DIR="$GIT_C_MATCH"
fi

# Fail-closed: if we can't determine the target directory, block
if [ -z "$TARGET_DIR" ]; then
  echo "BLOCKED: could not determine target directory for git command. Ask the user to commit manually." >&2
  exit 2
fi

# Get only push remote URLs for the target repo
PUSH_URLS=$(git -C "$TARGET_DIR" remote -v 2>/dev/null | grep '(push)' | awk '{print $2}')

# If we can't read remotes (not a git repo, etc.), block by default
if [ -z "$PUSH_URLS" ]; then
  echo "BLOCKED: Could not determine git push remotes for '$TARGET_DIR'. Ask the user to commit manually." >&2
  exit 2
fi

ALLOWED=false
while IFS= read -r url; do
  lc_url=$(echo "$url" | tr '[:upper:]' '[:lower:]')
  for pattern in "${WHITELIST[@]}"; do
    if echo "$lc_url" | grep -q "$pattern"; then
      ALLOWED=true
      break 2
    fi
  done
done <<< "$PUSH_URLS"

if [ "$ALLOWED" = "false" ]; then
  echo "BLOCKED: git commit/push not allowed for this repo. Push remotes:" >&2
  echo "$PUSH_URLS" >&2
  echo "Whitelisted patterns: ${WHITELIST[*]}" >&2
  exit 2
fi

exit 0
