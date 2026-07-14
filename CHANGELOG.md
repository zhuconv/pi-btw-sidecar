# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows semantic versioning.

## [Unreleased]

### Changed

- Register a single `/aside` root command with space-delimited subcommands to avoid collisions with OMP's built-in `/btw` command.

## [0.3.0] - 2026-07-03

### Added
- Added an `enabled` master config toggle to disable the extension without uninstalling. ([bf0fb4a](https://github.com/MasuRii/pi-btw-sidecar/commit/bf0fb4ab10bb6b9028250c090d78c903d9d1b192))

### Changed
- Widened Pi peer dependency ranges to 0.80 and added security dependency overrides. ([79fb903](https://github.com/MasuRii/pi-btw-sidecar/commit/79fb90382051c48827407c2b7b6a1332e1405e06))
- Extracted shared types and deduplicated utilities across the BTW runtime modules. ([bf0fb4a](https://github.com/MasuRii/pi-btw-sidecar/commit/bf0fb4ab10bb6b9028250c090d78c903d9d1b192))

## [0.2.1] - 2026-06-16

### Added
- Added inject-select mode for selecting and injecting specific transcript items back into the main session.
- Added `color` field support in agent frontmatter for per-agent accent styling.
- Added `unicode` and `emoji` icon modes alongside the existing `nerd` and `fallback` modes, with distinct icons for agents, session, model, and thinking status labels.

### Changed
- Migrated the BTW overlay input from `Input` to `Editor` with a configurable editor theme for improved text editing support.
- Dimmed non-ANSI parts of assistant transcript text to keep ANSI-decorated emphasis visible while reducing plain-text contrast.

## [0.2.0] - 2026-06-01

### Added

- Agent markdown discovery and modal-style `/btw:agent` selection.
- Session persistence for the selected BTW agent.
- README, changelog, license, package publication filters, and separated `src/test` layout.
- GitHub release review documentation, install paths, and npm package dry-run script.

### Changed

- Aligned npm package file boundaries with public Pi extension conventions by publishing the config template instead of runtime `config.json`.
- Replaced the hardcoded BTW sidecar prompt with the selected agent markdown instructions.
- Kept summary sessions anchored to the selected agent instructions plus the summarize task instruction.
- Isolated BTW sub-sessions from tools, skills, prompts, agents files, themes, extensions, and inherited main-session system prompts.
- Rendered assistant transcript text with markdown-aware TUI styling for emphasis such as bold and italic.
- Split the BTW runtime into core and overlay modules for deferred loading and smaller startup cost.
- Updated Pi peer and dev dependencies to 0.78-compatible ranges.

### Fixed

- BTW sub-sessions no longer force or inherit tool access when the main session has active tools available.
