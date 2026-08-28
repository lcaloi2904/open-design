# Antigravity Native `--model` Flag Migration

## Context

`apps/daemon/src/runtimes/defs/antigravity.ts` selects the `agy` model
through a settings-file side channel instead of a CLI flag, because when this
def was written `agy` v1.0.3 had no `--model` flag (upstream issue #35):

- `writeAntigravityModelSelection()` writes the chosen model's exact display
  label into `~/.gemini/antigravity-cli/settings.json` immediately before
  spawn.
- `agy -p <prompt>` re-reads that file on startup. The daemon confirms the
  write was picked up by polling the CLI's `--log-file` output for
  `Propagating selected model override to backend: label="<model>"`
  (`waitForAgyToReadModel`).
- Because `settings.json` is process-global, two concurrent OD runs that both
  pick a concrete (non-default) model can race — run A writes model A, spawn
  A starts, run B overwrites the file with model B before A's `agy` has read
  it, and A silently executes on model B. `acquireAntigravityModelLock` /
  `_resetAntigravityModelLockForTests` serialize non-default antigravity
  spawns through a per-process lock chain to avoid this.

This was discovered as a side note while fixing #(fallbackModels missing
Gemini 3.6/3.7 Flash tiers) on 2026-08-28: verified locally that the
currently-installed `agy` (1.1.22) now ships both a `--model <label>` flag
and a programmatic `agy models` subcommand. The settings.json + lock chain +
log-file poll workaround is no longer necessary for model selection, but
migrating it is a separate, larger change than the stale-list fix and was
deliberately deferred.

## Goal

Replace the settings.json side channel with `agy`'s native `--model` flag,
removing the race-avoidance machinery it exists solely to support, and wire
`agy models` into the same live-list pattern already used by
`apps/daemon/src/runtimes/defs/grok-build.ts` (`listModels: { args, timeoutMs,
parse }`) so the model catalogue stops needing manual updates when Google
ships new tiers.

## Current Evidence

Verified against the locally installed `agy` 1.1.22 on 2026-08-28:

- `agy --help` lists a `--model <label>` flag.
- `agy models` prints the same label set currently hardcoded in
  `antigravityAgentDef.fallbackModels`, in the same order.
- A live round-trip test (write `"Gemini 3.7 Flash (High)"` into
  `settings.json`, run `agy -p "say hi" --log-file <tmp>`) produced a real
  model response and the confirming log line
  `Propagating selected model override to backend: label="Gemini 3.7 Flash (High)"`,
  confirming the settings.json path still works today — this migration is an
  improvement, not a bug fix for currently-broken behavior.

## Required Change

In `apps/daemon/src/runtimes/defs/antigravity.ts`:

1. `buildArgs`: when `options.model` is set and not `DEFAULT_MODEL_OPTION.id`,
   push `'--model', options.model` into `args` instead of calling
   `writeAntigravityModelSelection`.
2. Remove `writeAntigravityModelSelection`, `acquireAntigravityModelLock`,
   `_resetAntigravityModelLockForTests`, and `waitForAgyToReadModel` once
   nothing calls them (check `apps/daemon/src/server.ts` for the lock/poll
   wiring around antigravity spawns — that call site also needs to drop its
   acquire/wait/release sequence for this def).
3. Add `listModels: { args: ['models'], timeoutMs: 10_000, parse: <parser> }`
   mirroring `grok-build.ts`'s pattern, so the catalogue is live instead of a
   hand-maintained `fallbackModels` array. Keep `fallbackModels` as the
   offline/failure fallback.
4. Confirm whether `--model` accepts the same exact label string `agy models`
   prints (e.g. `"Gemini 3.7 Flash (High)"`) or expects a distinct slug —
   the help text and `agy models` output should make this unambiguous: if
   they differ, the `listModels` parser needs to emit whatever `--model`
   actually expects, not the display label.

## Non-Goals

- No change to `supportsCustomModel: false` — the model set is still a
  server-side enum; this migration does not add support for arbitrary
  user-typed model ids.
- No change to the `'default'` id's meaning (leave `settings.json` untouched
  so `agy` keeps whatever the user last picked in its own TUI).
- No change to `promptViaStdin`, `streamFormat`, or the stateless
  full-transcript-per-spawn behavior documented above `buildArgs`.

## Risks

- `server.ts`'s antigravity spawn path currently gates lock release on the
  `--log-file` poll signal (`waitForAgyToReadModel`) or child exit; removing
  the settings.json write removes the reason for that gate, but the call
  site needs to be found and updated in the same change, not left dangling.
- Need to confirm `--model` behaves identically across all 15 fallback
  entries (Gemini, Claude, and GPT-OSS tiers), not just the Gemini tier
  exercised in the 2026-08-28 verification.
- If `agy models`' machine-readable output format differs from its
  human-readable stdout (e.g. needs `--json` or similar), the `listModels`
  parser needs to target the right invocation.

## Suggested Validation

```bash
pnpm --filter @open-design/daemon test -- antigravity
pnpm --filter @open-design/daemon typecheck
```

Plus a live round-trip per model tier (or a representative sample) using the
same manual verification method as the 2026-08-28 check: run `agy -p "say
hi" --model "<label>" --log-file <tmp>` and confirm both a real response and
the expected `--log-file` line (if `agy` still emits a comparable
confirmation line under `--model`; verify this before assuming the log-file
poll is even meaningful to keep as a smoke check).

## Acceptance Checklist

- `buildArgs` passes `--model <value>` directly; no `settings.json` write for
  non-default model selection.
- `writeAntigravityModelSelection`, `acquireAntigravityModelLock`,
  `_resetAntigravityModelLockForTests`, `waitForAgyToReadModel`, and their
  call sites in `server.ts` are removed (not left as dead code).
- `listModels` wired so `agy models` output feeds the live model list; stale
  `fallbackModels` no longer causes silent staleness like the 2026-08-28 bug.
- `apps/daemon/tests/runtimes/antigravity-model-lock.test.ts` either deleted
  (if it only tests the removed lock mechanism) or rewritten to cover the new
  `--model` path — do not leave it asserting behavior that no longer exists.
- `pnpm --filter @open-design/daemon typecheck` and the daemon test suite
  pass with no new failures beyond the pre-existing baseline.
