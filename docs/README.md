# Semantero documentation

Start with the page for what you want to do. Specs are design records: they explain why things are the way they are
and number the tests that pin each behaviour. Where an implementation differs from its spec, the decisions log says so.

| I want to… | Read |
|---|---|
| Install Semantero: **Obsidian only** or **Global** (Obsidian + notes + the Semantero app), and switch between them | [INSTALL.md](INSTALL.md#choose-your-setup) |
| Work on the code (architecture, commands, workflows, gotchas) | [DEVELOPMENT.md](DEVELOPMENT.md), then [AGENTS.md](../AGENTS.md) (rules) |
| Know why a design choice was made, what was measured, what's still open | [DECISIONS_AND_GAPS.md](DECISIONS_AND_GAPS.md) |
| Try other embedding models in the real plugin and app (Qwen3-Embedding 0.6B vs pplx-embed-v2-late) and switch between them | [EMBED_INSTALLS.md](EMBED_INSTALLS.md); pplx internals: [pplx/README.md](../pplx/README.md) |
| Check the plugin by hand | [MANUAL_CHECKS.md](MANUAL_CHECKS.md) |
| Check the launcher by hand | [macos/CHECK.md](../macos/CHECK.md) |
| Find known maintenance debt worth paying off (open items from the October 2026 code review) | [REVIEW_2026-10.md](REVIEW_2026-10.md) |

## Design records

| Spec | Covers | Status |
|---|---|---|
| [SEARCH_SPEC.md](SEARCH_SPEC.md) | Paper index (Zotero → `.planner/search/`), hybrid ranking, the Obsidian search pop-up, evaluation | implemented |
| [INTEGRATION_SPEC.md](INTEGRATION_SPEC.md) | Plugin integration: shared engine, inline `@@` citations, literature notes, related-papers panel, watcher, budgets B1–B14 | implemented |
| [LAUNCHER_SPEC.md](LAUNCHER_SPEC.md) | Notes index (`.planner/notes/`), `launcher-core`, the native macOS app (glass panel, actions, Spotlight), the JavaScriptCore-vs-Swift decision | implemented; manual checks in `macos/CHECK.md` |

## Where things live

```
README.md               what Semantero is, quick start for the paper search
AGENTS.md               rules for anyone (person or agent) changing the code: read before committing
docs/INSTALL.md         install tiers, tools per tier, uninstall, troubleshooting
docs/DEVELOPMENT.md     architecture, components, commands, workflows, testing, debugging, gotchas
docs/*_SPEC.md, SPEC.md design records (above)
docs/DECISIONS_AND_GAPS.md  decisions, measurements, deviations, open gaps (append-only log)
docs/MANUAL_CHECKS.md   plugin checklist          macos/CHECK.md   launcher checklist
```
