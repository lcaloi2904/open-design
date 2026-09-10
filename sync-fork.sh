#!/usr/bin/env bash
# Personal fork-sync helper for this fork (origin) against nexu-io/open-design (upstream).
#
# Keeps `main` a clean mirror of upstream/main, then rebases personal fixes on
# `mine` on top of the latest upstream, verifies, and pushes. Safe to re-run.
# Run it as:  git sync-fork      (alias -> bash sync-fork.sh)  or  bash sync-fork.sh
set -euo pipefail

MAIN=main
MINE=mine
UPSTREAM=upstream
ORIGIN=origin

cyan() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m[OK] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[STOP] %s\033[0m\n' "$*" >&2; exit 1; }

# Guard: never run on a dirty tree; uncommitted work would be lost or confused.
if [ -n "$(git status --porcelain)" ]; then
  git status --short
  die "Working tree not clean. Commit or stash your changes first, then re-run."
fi

cyan "Fetching $UPSTREAM"
git fetch "$UPSTREAM"

cyan "Fast-forwarding $MAIN to $UPSTREAM/$MAIN"
git checkout "$MAIN"
git merge --ff-only "$UPSTREAM/$MAIN" \
  || die "$MAIN is not a clean mirror (ff-only failed) — something was committed to $MAIN. Fix that before syncing."
git push "$ORIGIN" "$MAIN"
ok "$MAIN now mirrors $UPSTREAM/$MAIN"

git checkout "$MINE"
if git merge-base --is-ancestor "$MAIN" "$MINE"; then
  ok "$MINE already sits on the latest $MAIN — nothing new upstream, no rebase needed."
  exit 0
fi

cyan "Rebasing $MINE onto $MAIN"
if ! git rebase "$MAIN"; then
  printf '\n\033[1;31mRebase hit conflicts.\033[0m Resolve each conflicted file, then:\n'
  printf '    git add <files> && git rebase --continue\n'
  printf '  (rerere remembers repeats). To bail out completely: git rebase --abort\n'
  printf '  After the rebase finishes, re-run: git sync-fork\n'
  exit 1
fi
ok "$MINE rebased onto latest upstream"

cyan "Reinstalling deps + typechecking daemon"
pnpm install
pnpm --filter @open-design/daemon typecheck
ok "typecheck passed"

cyan "Pushing $MINE"
git push "$ORIGIN" "$MINE" --force-with-lease
ok "Done — $MINE is synced with upstream and pushed. Keep working on $MINE."
