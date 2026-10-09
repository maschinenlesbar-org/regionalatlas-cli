---
name: regionalatlas-catalog
description: >
  Browse the Regionalatlas Deutschland indicator catalogue (Statistische Ämter des
  Bundes und der Länder) using the regionalatlas-cli. Trigger when the user asks
  "what regional statistics are available?", "which indicators are there for
  population / elections / environment?", "find the code for Bevölkerungsstand",
  "which years does this indicator cover?", or wants to discover the themes and
  indicator codes before pulling data. Lists the 21 themes and the 71 indicators
  with their codes, titles and years, and resolves a topic to an indicator code.
compatibility: >
  Requires the `regionalatlas` CLI (npm package
  @maschinenlesbar.org/regionalatlas-cli) on PATH, installed by the user; the
  skill never installs it. Uses jq for JSON filtering. Network access to
  regionalatlas.statistikportal.de and www.gis-idmz.nrw.de.
---

# Regionalatlas Catalogue

The Regionalatlas publishes **21 themes (Themenbereiche)** and **71 indicators
(Indikatoren)** (on 2026-09-26). This skill browses that catalogue and finds the code you need for a
`query`.

## Tooling

This skill drives the `regionalatlas` command. **Before anything else, validate it is available** — run `command -v regionalatlas` (or `regionalatlas --version`). If it is not on your PATH, STOP and inform the user that the `regionalatlas` CLI (`@maschinenlesbar.org/regionalatlas-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

**No API key is required.** The catalogue is a public JSON file. `regionalatlas themes` lists the subject areas; `regionalatlas indicators [--theme …] [--year …] [--search …]` lists the indicators. `--compact` for `jq`. Data © Statistische Ämter des Bundes und der Länder under Datenlizenz Deutschland – Namensnennung 2.0 (dl-de/by-2.0, attribution required) — see DATA_LICENSE.md.

## What you get

| Command | Output |
|---|---|
| `regionalatlas themes` | `[{ title, indicatorCount }, …]` — the 21 subject areas |
| `regionalatlas indicators` | `[{ code, table, theme, titleShort, titleLong, years, levels, fields }, …]` — the indicators |

Indicator fields:

| Field | Meaning |
|---|---|
| `code` | catalogue id, e.g. `AI002-1-5` — pass this to `query` |
| `table` | SQL table form, e.g. `ai002_1_5` — also accepted by `query` |
| `theme` | the Themenbereich (subject area) |
| `titleShort` | short title of the indicator |
| `titleLong` | long title, e.g. `Regionalatlas Deutschland Themenbereich "Wahlen" Indikatoren zu "Bundestagswahl"`; `--search` matches it too |
| `years` | every year the catalogue offers, ascending, e.g. `["1998", "2002", …, "2025"]` — gaps are real (see Traps) |
| `levels` | per year, the geo levels with figures, e.g. `{ "2025": ["land"] }`; `query` refuses any other level for that year |
| `fields` | the indicator's value columns: `{ code, title, unit }` each, in the order `query` returns them. This is what a `values` key means; pass a `code` to `query --fields` |

## Recipes

```bash
# All themes with their indicator counts
regionalatlas themes --compact | jq -r '.[] | "\(.title)\t\(.indicatorCount)"'

# Find the population indicators (search over code + titles)
regionalatlas indicators --search bevölkerung --compact | jq '.[] | {code, titleShort, years}'

# Everything under a theme, offering a given year
regionalatlas indicators --theme Umwelt --year 2020 --compact | jq '.[].code'

# Resolve a topic to a code, then hand it to the map/compare skills.
# Search the broad topic: turnout ("Wahlbeteiligung") is a column inside AI005/AI006,
# not an indicator title, so --search wahlbeteiligung finds nothing.
regionalatlas indicators --search wahl --compact | jq -r '.[] | "\(.code)\t\(.titleShort)"'

# Does an indicator offer one specific year? (empty array = no)
regionalatlas indicators --search AI005 --year 2024 --compact
```

## Traps

- **`--search` matches code + short + long title**; `--theme` matches only the theme
  title. Both are case-insensitive substrings — try a stem (`bevölk`, `wahl`). The long
  title contains the theme name, so a theme word (`wahlen`, `umwelt`) matches every
  indicator of that theme.
- **`--search` does not see the value columns.** An indicator has several columns (`AI005`
  Bundestagswahl has seven: party shares and turnout), and `--search` matches only the
  code and the indicator's titles, not the column titles in `fields`, so a column topic
  such as `wahlbeteiligung` returns `[]`. Search the indicator's topic, then read its
  `fields` (`AI005` lists "Wahlbeteiligung, Bundestagswahl" there).
- **Years have gaps, and a listed year can still be empty.** `years` lists every year the
  catalogue offers: `AI005` offers just the election years (1998, 2002, 2005, 2009, 2013,
  2017, 2021, 2025), and `AI002-1-5` skips 2001–2004. But a few listed years have no
  figures at any level — their `levels` entry is `[]` (on 2026-10-05: `AI002-3` 2003 and
  2004, `AI008-2` 2006, `AIG-08-2`, `AI-N-07` 2006 and 2007), `indicators --year` still
  lists them, and `query` refuses them (exit 2). Pick a year whose `levels` entry names the
  level you want.
- **The newest catalogue year may not be loaded yet.** `AI013-1` listed years up to 2026 on
  2026-09-15, but `query` returned `[]` for 2026 (with an `INFO` note on stderr naming 2025).
  A year listed here is not a guarantee of data.
- **`values` keys are bare column codes — `indicators` says what they mean.** Each
  indicator row carries a `fields` list of `{code, title, unit}` in the order the data
  host returns the columns. Read the label from there; never infer it from the code
  order or the size of the numbers. `AI005` is the cautionary case: `ai0507` is the AfD
  share and `ai0506` is Wahlbeteiligung, so "the sixth party" is wrong. Units matter
  too — a Veränderungsrate on a share indicator is in percentage points (`ai0208v`),
  not percent.
- **The code is the handle** — pass `code` (`AI002-1-5`) or `table` (`ai002_1_5`) to
  `regionalatlas query`. To then pull the numbers → the **regionalatlas-map** or
  **regionalatlas-compare** skill.
- Cite the source: © Statistische Ämter des Bundes und der Länder (dl-de/by-2.0).
