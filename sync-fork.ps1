#!/usr/bin/env pwsh
# Personal fork-sync helper for Windows/PowerShell (pwsh 7+).
#
# Keeps `main` a clean mirror of upstream/main, then rebases personal fixes on
# `mine` on top of the latest upstream, verifies, and pushes. Safe to re-run.
# Run it as:  .\sync-fork.ps1
# If blocked by execution policy:  pwsh -ExecutionPolicy Bypass -File .\sync-fork.ps1

$ErrorActionPreference = 'Stop'
# Do not let git's stderr progress output trip PS 7.3+ native-error handling.
$PSNativeCommandUseErrorActionPreference = $false

$Main = 'main'; $Mine = 'mine'; $Upstream = 'upstream'; $Origin = 'origin'

function Cyan($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[OK] $m"   -ForegroundColor Green }
function Die($m)  { Write-Host "[STOP] $m" -ForegroundColor Red; exit 1 }

# Guard: never run on a dirty tree; uncommitted work would be lost or confused.
if (git status --porcelain) {
  git status --short
  Die 'Working tree not clean. Commit or stash your changes first, then re-run.'
}

Cyan "Fetching $Upstream"
git fetch $Upstream
if ($LASTEXITCODE -ne 0) { Die "git fetch $Upstream failed." }

Cyan "Fast-forwarding $Main to $Upstream/$Main"
git checkout $Main
if ($LASTEXITCODE -ne 0) { Die "git checkout $Main failed." }
git merge --ff-only "$Upstream/$Main"
if ($LASTEXITCODE -ne 0) { Die "$Main is not a clean mirror (ff-only failed) - something was committed to $Main. Fix that before syncing." }
git push $Origin $Main
if ($LASTEXITCODE -ne 0) { Die "git push $Main failed." }
Ok "$Main now mirrors $Upstream/$Main"

git checkout $Mine
if ($LASTEXITCODE -ne 0) { Die "git checkout $Mine failed." }

# Skip the rebase entirely when nothing new landed upstream.
git merge-base --is-ancestor $Main $Mine
if ($LASTEXITCODE -eq 0) {
  Ok "$Mine already sits on the latest $Main - nothing new upstream, no rebase needed."
  exit 0
}

Cyan "Rebasing $Mine onto $Main"
git rebase $Main
if ($LASTEXITCODE -ne 0) {
  Write-Host "`nRebase hit conflicts." -ForegroundColor Red
  Write-Host "Resolve each conflicted file, then:"
  Write-Host "    git add <files>; git rebase --continue"
  Write-Host "  (rerere remembers repeats). To bail out completely: git rebase --abort"
  Write-Host "  After the rebase finishes, re-run: .\sync-fork.ps1"
  exit 1
}
Ok "$Mine rebased onto latest upstream"

Cyan "Reinstalling deps + typechecking daemon"
pnpm install
if ($LASTEXITCODE -ne 0) { Die "pnpm install failed." }
pnpm --filter '@open-design/daemon' typecheck
if ($LASTEXITCODE -ne 0) { Die "daemon typecheck failed - fix before pushing." }
Ok "typecheck passed"

Cyan "Pushing $Mine"
git push $Origin $Mine --force-with-lease
if ($LASTEXITCODE -ne 0) { Die "git push $Mine failed (force-with-lease rejected? someone else pushed to $Mine)." }
Ok "Done - $Mine is synced with upstream and pushed. Keep working on $Mine."
