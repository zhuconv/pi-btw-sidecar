# pi-btw-sidecar

[![npm version](https://img.shields.io/npm/v/pi-btw-sidecar?style=flat-square)](https://www.npmjs.com/package/pi-btw-sidecar) [![License](https://img.shields.io/github/license/MasuRii/pi-btw-sidecar?style=flat-square)](LICENSE)

Persistent `/btw` side conversations for the [Pi coding agent](https://github.com/mariozechner/pi).

`pi-btw-sidecar` opens a focused, non-capturing modal sidecar session, keeps BTW discussion separate from the main transcript, and can inject or summarize the side conversation back into the main session on request.

- **npm**: https://www.npmjs.com/package/pi-btw-sidecar
- **GitHub**: https://github.com/MasuRii/pi-btw-sidecar

## Features

- `/btw` contextual side thread with current main-session context.
- `/btw:tangent` contextless tangent thread.
- Modal BTW composer with streaming markdown transcript, scrolling, and Escape dismissal.
- Agent selection from `agent/agents/*.md` via `/btw:agent`; the selected agent markdown body becomes the sidecar instruction prompt. Agent frontmatter `color` field is used for per-agent accent styling.
- BTW-only model and thinking overrides with `/btw:model` and `/btw:thinking`.
- Transcript item selection for inject: when injecting the BTW thread, an interactive selection mode lets the user pick specific transcript items before injection.
- Isolated no-tool sub-sessions: BTW agents receive selected instructions and seeded conversation context without tools, skills, prompts, agents files, themes, extension resource collections, or inherited main-session system prompts.
- Configurable icon mode (`nerd`, `unicode`, `emoji`, or `auto`/`fallback`) with distinct icons for agents, session, model, and thinking status labels.
- Debug logging controlled by root `config.json`, with logs written only under extension-local `debug/` when enabled.

## Installation

### npm package

```bash
pi install npm:pi-btw-sidecar
```

### Git repository

```bash
pi install git:github.com/MasuRii/pi-btw-sidecar
```

### Local extension folder

Place this folder in one of Pi's extension discovery paths:

```text
# Global default when PI_CODING_AGENT_DIR is unset
~/.pi/agent/extensions/pi-btw-sidecar

# Project-specific
.pi/extensions/pi-btw-sidecar
```

Pi discovers the extension through the root `index.ts` entry listed in `package.json`, which forwards to `src/btw-runtime.ts`.

## Commands

| Command | Description |
| --- | --- |
| `/btw [prompt]` | Open or continue the contextual BTW thread. Add `--save` to persist a visible note. |
| `/btw:tangent [prompt]` | Open or continue a contextless tangent thread. |
| `/btw:agent [name\|list]` | Pick, list, or set the BTW instruction agent. |
| `/btw:new [prompt]` | Reset BTW and start a fresh contextual thread. |
| `/btw:clear` | Clear BTW state and dismiss the modal. |
| `/btw:inject [instructions]` | Inject the full BTW thread into the main session. |
| `/btw:summarize [instructions]` | Summarize the BTW thread and inject the summary. |
| `/btw:model [provider model api\|clear]` | Show, set, or clear the BTW-only model override. |
| `/btw:thinking [level\|clear]` | Show, set, or clear the BTW-only thinking override. |

## Configuration

Runtime configuration is stored at the extension root:

```text
~/.pi/agent/extensions/pi-btw-sidecar/config.json
```

A starter template is included at `config/config.example.json`. Missing `config.json` or missing keys fall back to production defaults.

```bash
cp config/config.example.json config.json
```

### Configuration options

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `debug` | `boolean` | `false` | Enables debug logging under `debug/debug.log`. |
| `showReasoning` | `boolean` | `true` | Shows sidecar assistant reasoning text when Pi exposes it. |
| `modalSize` | `"small" \| "medium" \| "large"` | `"medium"` | Controls the default BTW modal size. |

Example:

```json
{
  "debug": false,
  "showReasoning": true,
  "modalSize": "medium"
}
```

Invalid values are reported through Pi diagnostics and replaced with bounded defaults.

## Debug logging

Debug logging is disabled by default through `"debug": false`. When enabled, logs are appended only to:

```text
debug/debug.log
```

The extension does not write debug output to `console`, `stdout`, or `stderr`, and no debug directory or log handle is created when debug logging is disabled.

## Repository structure

```text
pi-btw-sidecar/
├── index.ts                         # Stable Pi extension entrypoint for auto-discovery
├── src/
│   ├── btw-runtime.ts               # Command registration and sidecar session orchestration
│   ├── agent-discovery.ts           # Agent markdown discovery and selection state
│   ├── agent-selection-ui.ts        # `/btw:agent` picker UI helpers
│   ├── config.ts                    # Config loading, validation, and defaults
│   ├── debug-logger.ts              # File-only debug logger gated by config.json
│   └── icons.ts                     # Modal icon sets (nerd, unicode, emoji, fallback modes)
├── src/test/
│   └── btw-runtime.test.ts
├── config/
│   └── config.example.json          # Starter config template
├── CHANGELOG.md
├── LICENSE
├── package.json
├── README.md
└── tsconfig.json
```

## Development

```bash
npm install
npm run build
npm run lint
npm run test
npm run check
npm run package:dry-run
```

## Publishing

The package metadata follows the publish-ready shape used by established Pi extensions:

- entrypoint: `index.ts`
- package exports: `.` → `./index.ts`
- Pi extension manifest: `pi.extensions`
- repository, bugs, and homepage links target `MasuRii/pi-btw-sidecar`
- published files: source, README, changelog, license, and config template
- runtime `config.json`, `debug/` logs, tests, and build artifacts excluded from npm publication

Do not publish, push, or tag until the GitHub repository has been manually reviewed.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history.

## License

[MIT](LICENSE) © MasuRii
