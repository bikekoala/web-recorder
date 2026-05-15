#!/usr/bin/env bash
# Stop hook — runs when a Claude Code session ends.
#
# Purpose: nudge the AI to do end-of-phase cleanup BEFORE context is lost.
# The user's standing rule (memory: feedback-cleanup-scaffolding) says
# temporary/diagnostic code must be deleted or hardened when its phase
# ends, never left to rot.  The hook scans the uncommitted working tree
# for patterns that smell like scaffolding and surfaces them as a
# `systemMessage` for Claude to act on in the same turn.
#
# Output contract: a single JSON object on stdout. See:
#   https://docs.claude.com/en/docs/claude-code/hooks
#
# Run cheap-and-fast — Stop hooks have a 15s timeout but should finish in <1s.
# Exit 0 always (advisory only); never block session close.

set -u
cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" || exit 0

# Skip silently if not a git repo (CI / first-run / detached state).
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

findings=()

# 1) Look for diagnostic / scaffolding patterns introduced in unstaged changes.
#    Match against `git diff` of TS/JS/scripts/tests — restricted to ADDED lines.
diff_added=$(git diff --unified=0 -- '*.ts' '*.js' '*.sh' 'scripts/*' 'tests/*' 2>/dev/null | grep -E '^\+[^+]' || true)

scaffolding_hits=$(printf '%s\n' "$diff_added" \
  | grep -ciE '(console\.log|console\.error|console\.warn|\.only\(|\.skip\(|\bdebugger\b|// *(TODO|FIXME|XXX|HACK)|// *(debug|scaffold|temp|temporary|remove me|kill this))' \
  || true)

if [ "${scaffolding_hits:-0}" -gt 0 ]; then
  findings+=("**$scaffolding_hits scaffolding-shaped line(s) in unstaged diff** — run \`git diff | grep -nE 'console\\.log|\\.only\\(|debugger|TODO|FIXME|temporary'\` to locate. Per the cleanup-scaffolding rule: delete or harden before commit.")
fi

# 2) New findings file with no entry in docs/findings/README.md.
untracked_findings=$(git ls-files --others --exclude-standard docs/findings/ 2>/dev/null | grep -E '\.md$' | grep -v README || true)
if [ -n "$untracked_findings" ]; then
  for f in $untracked_findings; do
    base=$(basename "$f")
    if ! grep -q "$base" docs/findings/README.md 2>/dev/null; then
      findings+=("**New finding \`$base\` is not indexed in \`docs/findings/README.md\`** — add it under Active or Historical with a one-line hook.")
    fi
  done
fi

# 3) CLAUDE.md staleness — src/ changed but CLAUDE.md untouched this session.
if git diff --quiet HEAD CLAUDE.md 2>/dev/null && ! git diff --quiet HEAD -- 'src/' 2>/dev/null; then
  src_changed=$(git diff --name-only HEAD -- 'src/' 2>/dev/null | wc -l | tr -d ' ')
  if [ "${src_changed:-0}" -gt 5 ]; then
    findings+=("**CLAUDE.md unchanged while $src_changed src/ file(s) changed** — confirm none of the changes was load-bearing enough to mention in the root pointer doc.")
  fi
fi

# 4) Tasks left in_progress — claim or close.
in_progress_marker=""
if command -v jq >/dev/null 2>&1 && [ -d "${HOME}/.claude/projects" ]; then
  # Best-effort — tasks aren't reliably introspectable from a hook, so
  # this branch is a placeholder.  We rely on the in-conversation Task
  # tools instead.
  :
fi

if [ "${#findings[@]}" -eq 0 ]; then
  exit 0
fi

# Build the systemMessage. JSON-encode safely via a small Python helper
# (every macOS has python3; if not, we degrade to a raw string and accept
# that newlines/quotes might confuse Claude Code).
if command -v python3 >/dev/null 2>&1; then
  msg=$(printf '%s\n' "End-of-session cleanup checklist (stop-hook):" "" "${findings[@]}" "" "Address these before declaring the session done, OR explicitly note why each one is being left." \
    | python3 -c 'import json,sys; print(json.dumps({"continue": True, "suppressOutput": False, "systemMessage": sys.stdin.read()}))')
else
  msg='{"continue":true,"suppressOutput":false,"systemMessage":"Stop-hook surfaced cleanup candidates — re-run the hook script for details."}'
fi
printf '%s\n' "$msg"
exit 0
