# Skills

`regionalatlas-cli` ships **Claude Code Agent Skills** as a Claude Code plugin, so
Claude can drive the `regionalatlas` CLI for common regional-statistics tasks. The
skills **validate** that the `regionalatlas` CLI is on your PATH and tell you if it is
missing — they never install anything.

| Skill | Use it when you want to… |
|---|---|
| **regionalatlas-catalog** | Browse the 21 themes and 70 indicators — discover the code for a topic, and see which years an indicator covers. |
| **regionalatlas-map** | Fetch an indicator for **every** region at a level (Bundesland / Regierungsbezirk / Kreis / Gemeinde) — the data behind a choropleth. |
| **regionalatlas-compare** | Pick out **specific** regions and set an indicator side by side — a few named regions, or the extremes of the whole set. |

They compose: **catalog → map**, or **catalog → compare**.

## Requirements

- The `regionalatlas` CLI on PATH: `npm install -g @maschinenlesbar.org/regionalatlas-cli`.
- **No API key** — the Regionalatlas data is open.
- **Notes:** the indicator, geo level, and year are validated against the catalogue
  before any query runs (an unknown indicator/level/year is a usage error, not a bad
  request); `query` returns one row per region as `{ ags, name, typ, level, year, values }`;
  `--region`/`--fields` filter and project client-side; leaving out `--year` uses the
  newest catalogue year, which may not be loaded yet (an empty result then carries a
  `Note:` on stderr naming the previous year).

## Installing the plugin

This repo is a Claude Code plugin (`.claude-plugin/plugin.json` + `skills/`),
published as `regionalatlas` in the
[maschinenlesbar.org plugin marketplace](https://github.com/maschinenlesbar-org/plugins).
Install it inside Claude Code to enable the three skills:

```
/plugin marketplace add maschinenlesbar-org/plugins
/plugin install regionalatlas@maschinenlesbar
```

The `skills/` and `.claude-plugin/` files are **not** shipped in the npm tarball — the
published package is the client/CLI only.

The data these skills surface is the Statistische Ämter des Bundes und der Länder's,
under **Datenlizenz Deutschland – Namensnennung 2.0** (dl-de/by-2.0, attribution
required) — see [DATA_LICENSE.md](DATA_LICENSE.md). Cite the source.
