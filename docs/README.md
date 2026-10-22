# daito documentation

Start with the page for what you want to do. Specs are design records: they explain why things are the way they are
and number the tests that pin each behaviour. Where an implementation differs from its spec, the decisions log says so.

| I want to… | Read |
|---|---|
| Install daito (Obsidian only, notes, the launcher app, the planner) | [INSTALL.md](INSTALL.md) |
| Work on the code (architecture, commands, workflows, gotchas) | [DEVELOPMENT.md](DEVELOPMENT.md), then [AGENTS.md](../AGENTS.md) (rules) |
| Know why a design choice was made, what was measured, what's still open | [DECISIONS_AND_GAPS.md](DECISIONS_AND_GAPS.md) |
| Check the plugin by hand | [MANUAL_CHECKS.md](MANUAL_CHECKS.md) |
| Check the launcher by hand | [macos/CHECK.md](../macos/CHECK.md) |

## Design records

| Spec | Covers | Status |
|---|---|---|
| [SPEC.md](SPEC.md) | The planner: daily-note extraction, brief, `Threads.md`, weekly review, health checks | implemented |
| [SEARCH_SPEC.md](SEARCH_SPEC.md) | Paper index (Zotero → `.planner/search/`), hybrid ranking, the Obsidian search pop-up, evaluation | implemented |
| [INTEGRATION_SPEC.md](INTEGRATION_SPEC.md) | Plugin integration: shared engine, inline `@@` citations, literature notes, related-papers panel, watcher, budgets B1–B14 | implemented |
| [LAUNCHER_SPEC.md](LAUNCHER_SPEC.md) | Notes index (`.planner/notes/`), `launcher-core`, the native macOS app (glass panel, actions, Spotlight), the JavaScriptCore-vs-Swift decision | implemented; manual checks in `macos/CHECK.md` |

## Where things live

```
README.md               what daito is, quick start for the paper search
AGENTS.md               rules for anyone (person or agent) changing the code: read before committing
docs/INSTALL.md         install tiers, tools per tier, uninstall, troubleshooting
docs/DEVELOPMENT.md     architecture, components, commands, workflows, testing, debugging, gotchas
docs/*_SPEC.md, SPEC.md design records (above)
docs/DECISIONS_AND_GAPS.md  decisions, measurements, deviations, open gaps (append-only log)
docs/MANUAL_CHECKS.md   plugin checklist          macos/CHECK.md   launcher checklist
```
