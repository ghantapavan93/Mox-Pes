#!/usr/bin/env bash
# Makes a build mirror (a detached worktree of this repo) hold exactly this working tree's files,
# so builds and test runs happen outside the main folder, whose .next is the verified B20
# recording build and must never be rebuilt. Usage (Git Bash, from the repo):
#
#   bash docs/agent-work/release/harness/sync-mirror.sh <mirrorDir>
#
# Copies every file that differs from the mirror's base commit (tracked changes, deletions and
# untracked files that are not ignored), and returns any file the mirror changed on its own to the
# base, so a change reverted here is reverted there too. Paths that never ship are skipped.
set -euo pipefail

SRC="$(git rev-parse --show-toplevel)"
DST="${1:?mirror dir}"
BASE="$(git -C "$DST" rev-parse HEAD)"

skip() {
  case "$1" in
    .claude/*|research/*|docs/outreach.md|docs/agent-work/MASTER-MISSION.md) return 0 ;;
    docs/agent-work/product-audit/walk*|*.stackdump) return 0 ;;
  esac
  return 1
}

changed_in() { # files that differ from BASE in a tree: tracked changes and untracked files
  { git -C "$1" diff --name-only "$BASE"; git -C "$1" ls-files --others --exclude-standard; } | sort -u
}

WANT="$(mktemp)"
changed_in "$SRC" >"$WANT"

copied=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  skip "$f" && continue
  if [ -e "$SRC/$f" ]; then
    mkdir -p "$DST/$(dirname "$f")"
    cp -p "$SRC/$f" "$DST/$f"
  else
    rm -f "$DST/$f"
  fi
  copied=$((copied + 1))
done <"$WANT"

restored=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  grep -qxF "$f" "$WANT" && ! skip "$f" && continue
  if git -C "$DST" cat-file -e "$BASE:$f" 2>/dev/null; then
    git -C "$DST" checkout -q "$BASE" -- "$f"
  else
    rm -f "$DST/$f"
  fi
  restored=$((restored + 1))
done < <(changed_in "$DST")

rm -f "$WANT"
echo "mirror $DST at $BASE: $copied synced, $restored restored to base"
