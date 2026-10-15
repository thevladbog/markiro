#!/bin/bash
cd /tmp/claude/wt/integ || exit 1
for n in "$@"; do
  d=/tmp/claude/wt/$n
  [ -d "$d" ] || continue
  git worktree remove --force "$d" 2>/dev/null
  [ -d "$d" ] && rm -rf "$d"
  echo "removed $n free=$(df -h / | tail -1 | awk '{print $4}')"
done
git worktree prune
echo done
