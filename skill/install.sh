#!/bin/sh
# Install the Lease guard into the current git repository.
#   sh /path/to/lease/skill/install.sh
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(git rev-parse --show-toplevel)"
mkdir -p "$ROOT/.lease/hooks"
cp "$SRC/hooks/lease-guard.mjs" "$SRC/hooks/lease-paths.mjs" "$ROOT/.lease/hooks/"
grep -qx '.lease/' "$ROOT/.git/info/exclude" 2>/dev/null || echo '.lease/' >> "$ROOT/.git/info/exclude"

HOOK="$(git rev-parse --git-path hooks)/pre-commit"
if [ -e "$HOOK" ] && ! grep -q lease-guard "$HOOK"; then
  echo "A pre-commit hook already exists at $HOOK. Add this line to it:"
  echo '  node "$(git rev-parse --show-toplevel)/.lease/hooks/lease-guard.mjs" precommit || exit 1'
else
  printf '#!/bin/sh\nnode "$(git rev-parse --show-toplevel)/.lease/hooks/lease-guard.mjs" precommit\n' > "$HOOK"
  chmod +x "$HOOK"
fi

SETTINGS="$ROOT/.claude/settings.local.json"
if [ ! -e "$SETTINGS" ]; then
  mkdir -p "$ROOT/.claude"
  cp "$SRC/hooks/claude-settings.json" "$SETTINGS"
  echo "Claude Code hooks written to .claude/settings.local.json"
else
  echo "Merge $SRC/hooks/claude-settings.json into $SETTINGS to enable the Claude Code hooks."
fi
mkdir -p "$ROOT/.claude/skills/lease" && cp "$SRC/SKILL.md" "$ROOT/.claude/skills/lease/SKILL.md"
echo "Lease guard installed. Edits and commits now need an active Lease (LEASE_GUARD=off to bypass)."
