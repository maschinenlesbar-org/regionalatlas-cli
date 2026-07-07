---
name: regionalatlas-catalog
description: >
  Browse the Regionalatlas Deutschland indicator catalogue (Statistische Ämter des
  Bundes und der Länder) using the regionalatlas-cli. Trigger when the user asks
  "what regional statistics are available?", "which indicators are there for
  population / elections / environment?", "find the code for Bevölkerungsstand",
  "which years does this indicator cover?", or wants to discover the themes and
  indicator codes before pulling data. Lists the 21 themes and the 70 indicators
  with their codes, titles and year ranges, and resolves a topic to an indicator code.
version: 1.0.0
userInvocable: true
---

# Regionalatlas Catalogue

The Regionalatlas publishes **21 themes (Themenbereiche)** and **70 indicators
(Indikatoren)**. This skill browses that catalogue and finds the code you need for a
`query`.

## Tooling

This skill drives the `regionalatlas` command. **Before anything else, validate it is available** — run `command -v regionalatlas` (or `regionalatlas --version`). If it is not on your PATH, STOP and inform the user that the `regionalatlas` CLI (`@maschinenlesbar.org/regionalatlas-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**No API key is required.** The catalogue is a public JSON file. `regionalatlas themes` lists the subject areas; `regionalatlas indicators [--theme …] [--year …] [--search …]` lists the indicators. `--compact` for `jq`. Data © Statistische Ämter des Bundes und der Länder under Datenlizenz Deutschland – Namensnennung 2.0 (dl-de/by-2.0, attribution required) — see DATA_LICENSE.md.

## What you get

| Command | Output |
|---|---|
| `regionalatlas themes` | `[{ title, indicatorCount }, …]` — the 21 subject areas |
| `regionalatlas indicators` | `[{ code, table, theme, titleShort, years }, …]` — the indicators |

Indicator fields:

| Field | Meaning |
|---|---|
| `code` | catalogue id, e.g. `AI002-1-5` — pass this to `query` |
| `table` | SQL table form, e.g. `ai002_1_5` — also accepted by `query` |
| `theme` | the Themenbereich (subject area) |
| `titleShort` | short title of the indicator |
| `years` | available-year range, e.g. `2000–2024` |

## Recipes

```bash
# All themes with their indicator counts
regionalatlas themes --compact | jq -r '.[] | "\(.title)\t\(.indicatorCount)"'

# Find the population indicators (search over code + titles)
regionalatlas indicators --search bevölkerung --compact | jq '.[] | {code, titleShort, years}'

# Everything under a theme, offering a given year
regionalatlas indicators --theme Umwelt --year 2020 --compact | jq '.[].code'

# Resolve a topic to a code, then hand it to the map/compare skills
regionalatlas indicators --search wahlbeteiligung --compact | jq -r '.[0].code'
```

## Traps

- **`--search` matches code + short + long title**; `--theme` matches only the theme
  title. Both are case-insensitive substrings — try a stem (`bevölk`, `wahl`).
- **Not every indicator offers every year** — the `years` range is per-indicator; use
  `--year` here to keep only those that cover a given year.
- **The code is the handle** — pass `code` (`AI002-1-5`) or `table` (`ai002_1_5`) to
  `regionalatlas query`. To then pull the numbers → the **regionalatlas-map** or
  **regionalatlas-compare** skill.
- Cite the source: © Statistische Ämter des Bundes und der Länder (dl-de/by-2.0).
