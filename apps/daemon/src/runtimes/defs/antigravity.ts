import { DEFAULT_MODEL_OPTION } from './shared.js';
import { agentCapabilities } from '../capabilities.js';
import type { RuntimeAgentDef, RuntimeModelOption } from '../types.js';

const ANTIGRAVITY_SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions';

// `agy` v1.0.3 had no `--model` flag (upstream issue #35). As of 1.1.22
// (verified 2026-08-28, logged in) `--model` accepts either the slug or
// the display label and emits `Propagating selected model override to
// backend: label="<X>"` on every tier (Gemini/Claude/GPT-OSS) — the same
// label OD already used with the settings.json write path. `buildArgs`
// passes `--model <label>` directly in argv, so there is no shared
// mutable state between concurrent spawns and no need for a lock or a
// log-file poll.
//
// Two ids the picker exposes are special:
//   - 'default'         : omit `--model` entirely, so agy keeps
//                         whatever the user last picked in its own TUI.
//                         (Respects user choice when they switch models
//                         from `agy` directly.)
//   - any other id      : the literal display label agy expects (e.g.
//                         "Gemini 3.1 Pro (High)", "Claude Sonnet 4.6
//                         (Thinking)"). Passed verbatim as the flag value.
//
// `supportsCustomModel: false` because the label set is a server-side
// enum — a typed id agy doesn't recognise resolves to a silent
// `availableModels` cache miss + empty print-mode output, which surfaces
// to the user as a generic "empty response" error.
//
// These labels mirror `agy models` (confirmed 2026-08-28, agy 1.1.22),
// in the same order that command lists them, and double as the offline/
// failure fallback for the live `listModels` fetch below.

// `agy models` prints a `Fetching available models...` prose line followed
// by tab-separated `<slug>\t<display label>` rows (verified 2026-08-28, agy
// 1.1.22, logged in). Emit `{ id: label, label }` — discarding the slug
// column — because `mergeFallbackModelMetadata` merges live entries with
// `fallbackModels` by `id`, and `fallbackModels[].id` is the display label
// that `buildArgs` passes as the `--model` flag value.
export function parseAntigravityModels(stdout: string): RuntimeModelOption[] {
  const seen = new Set<string>();
  const out: RuntimeModelOption[] = [DEFAULT_MODEL_OPTION];
  for (const rawLine of String(stdout || '').split('\n')) {
    const [slug, ...rest] = rawLine.split('\t');
    const label = rest.join('\t').trim();
    if (!slug?.trim() || !label || seen.has(label)) continue;
    seen.add(label);
    out.push({ id: label, label });
  }
  return out;
}

export const antigravityAgentDef = {
  id: 'antigravity',
  name: 'Antigravity',
  bin: 'agy',
  versionArgs: ['--version'],
  helpArgs: ['--help'],
  capabilityFlags: {
    [ANTIGRAVITY_SKIP_PERMISSIONS_FLAG]: 'skipPermissions',
  },
  listModels: {
    args: ['models'],
    timeoutMs: 10_000,
    parse: parseAntigravityModels,
  },
  fallbackModels: [
    DEFAULT_MODEL_OPTION,
    { id: 'Gemini 3.7 Flash (High)', label: 'Gemini 3.7 Flash (High)' },
    { id: 'Gemini 3.7 Flash (Medium)', label: 'Gemini 3.7 Flash (Medium)' },
    { id: 'Gemini 3.7 Flash (Low)', label: 'Gemini 3.7 Flash (Low)' },
    { id: 'Gemini 3.6 Flash (High)', label: 'Gemini 3.6 Flash (High)' },
    { id: 'Gemini 3.6 Flash (Medium)', label: 'Gemini 3.6 Flash (Medium)' },
    { id: 'Gemini 3.6 Flash (Low)', label: 'Gemini 3.6 Flash (Low)' },
    { id: 'Gemini 3.5 Flash (High)', label: 'Gemini 3.5 Flash (High)' },
    { id: 'Gemini 3.5 Flash (Medium)', label: 'Gemini 3.5 Flash (Medium)' },
    { id: 'Gemini 3.5 Flash (Low)', label: 'Gemini 3.5 Flash (Low)' },
    { id: 'Gemini 3.1 Pro (High)', label: 'Gemini 3.1 Pro (High)' },
    { id: 'Gemini 3.1 Pro (Low)', label: 'Gemini 3.1 Pro (Low)' },
    {
      id: 'Claude Sonnet 4.6 (Thinking)',
      label: 'Claude Sonnet 4.6 (Thinking)',
    },
    { id: 'Claude Opus 4.6 (Thinking)', label: 'Claude Opus 4.6 (Thinking)' },
    { id: 'GPT-OSS 120B (Medium)', label: 'GPT-OSS 120B (Medium)' },
  ],
  supportsCustomModel: false,
  // We deliberately do NOT opt into `resumesSessionViaCli` / agy's `-c`
  // resume flag on follow-up turns. Tested both shapes; `-c` activates
  // agy's internal agentic loop (multi-step model retries, tool calls,
  // fallback-to-cached-response on tool errors) which can't be steered
  // from OD's system-prompt OVERRIDE — even with the strongest wording
  // we got an identical byte-for-byte form re-emission on turn 2 when
  // turn 1's tool-call retry path returned the cached form response.
  //
  // Instead we treat agy as a stateless plain adapter like qwen /
  // deepseek: every spawn gets the full OD-rendered transcript via
  // `buildDaemonTranscript`, and that transcript's prior assistant
  // turns are sanitized to strip `<question-form>` markup + form-schema
  // JSON fences (see `sanitizePriorAssistantTurnForTranscript` in
  // apps/web/src/providers/daemon.ts). The stronger OVERRIDE block
  // composed in server.ts gives a second line of defense for weak
  // plain-stream models like Gemini 3.5 Flash.
  buildArgs: (
    prompt,
    _imagePaths,
    _extra = [],
    options = {},
    runtimeContext = {},
  ) => {
    // Print mode passes the composed prompt as `-p <prompt>`. Current agy
    // treats `-p -` as a literal prompt and does not read stdin (#7161),
    // so the prompt must remain in argv.
    const args: string[] = [];
    // Always opt into `--log-file` when the daemon supplied a path so
    // it can post-exit grep for the actual upstream failure shape
    // (auth missing vs quota reached vs upstream error) — without it
    // the chat surfaces a generic "empty response" because print mode
    // never echoes those errors on stdout. See server.ts empty-output
    // guard for the consumer.
    //
    // Flag order is load-bearing on agy: put `--log-file` before `-p`
    // so diagnostics (model override / auth / quota) land in the log.
    if (runtimeContext.agentLogFilePath) {
      args.push('--log-file', runtimeContext.agentLogFilePath);
    }
    // 'default' leaves the flag off entirely so agy keeps whatever model
    // its own TUI last selected; any other id is the literal display
    // label agy's `--model` flag expects.
    if (options.model && options.model !== DEFAULT_MODEL_OPTION.id) {
      args.push('--model', options.model);
    }
    // Daemon-managed print-mode runs have no interactive approval channel.
    if (agentCapabilities.get('antigravity')?.skipPermissions) {
      args.push(ANTIGRAVITY_SKIP_PERMISSIONS_FLAG);
    }
    args.push('-p', prompt);
    return args;
  },
  promptViaStdin: false,
  streamFormat: 'plain',
  installUrl: 'https://antigravity.google/cli',
  docsUrl: 'https://antigravity.google/docs/cli-overview',
} satisfies RuntimeAgentDef;
