---
name: regionalatlas-map
description: >
  Fetch a Regionalatlas Deutschland indicator for every region at a chosen level
  (Bundesland, Regierungsbezirk, Kreis or Gemeinde) using the regionalatlas-cli.
  Trigger when the user asks "show indicator X for all Bundesländer", "population
  density per Kreis", "map this indicator across Germany", "give me the values by
  Landkreis for 2022", or wants one row per region for a year. Runs the data query,
  maps the geo level to the right typ, and returns ags + name + values per region.
version: 1.0.0
userInvocable: true
---

# Regionalatlas Map (indicator by region)

Pull one indicator for **every region** at a chosen geo level and year — the data
behind a choropleth map.

## Tooling

This skill drives the `regionalatlas` command. **Before anything else, validate it is available** — run `command -v regionalatlas` (or `regionalatlas --version`). If it is not on your PATH, STOP and inform the user that the `regionalatlas` CLI (`@maschinenlesbar.org/regionalatlas-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**No API key is required.** `regionalatlas query <code> --level <land|regierungsbezirk|kreis|gemeinde> [--year …] [--region …] [--fields …]` returns one row per region. `--compact` for `jq`. Data © Statistische Ämter des Bundes und der Länder under Datenlizenz Deutschland – Namensnennung 2.0 (dl-de/by-2.0, attribution required) — see DATA_LICENSE.md.

## Geo levels (`--level`)

| `--level` (aliases) | typ | Regions |
|---|---|---|
| `land` (`laender`, `bundesland`) | 1 | 16 Bundesländer |
| `regierungsbezirk` (`rb`) | 2 | Regierungsbezirke |
| `kreis` (`kreise`, `landkreis`) | 3 | ~400 Kreise / kreisfreie Städte |
| `gemeinde` (`gemeinden`) | 5 | Gemeinden (many thousands) |

## Row shape

`query` returns `[{ ags, name, typ, level, year, values }, …]`:

| Field | Meaning |
|---|---|
| `ags` | Amtlicher Gemeindeschlüssel (region key, a string; leading zeros matter) |
| `name` | Gebietsname (region name) |
| `year` | reporting year |
| `values` | `{ <valueField>: number\|null }` — the indicator's value columns, keyed by bare codes (`ai0201`), with no label or unit |

## Recipes

```bash
# One indicator for all 16 Bundesländer, a specific year
regionalatlas query AI002-1-5 --level land --year 2020 --compact | jq '.[] | {name, values}'

# The same by Kreis (newest catalogue year by default), one value field only
regionalatlas query AI002-1-5 --level kreis --fields ai0201 --compact \
  | jq -r '.[] | "\(.ags)\t\(.name)\t\(.values.ai0201)"'

# Rank Bundesländer by a value field, top 5
regionalatlas query AI002-1-5 --level land --fields ai0201 --compact \
  | jq 'sort_by(.values.ai0201) | reverse | .[:5] | .[] | {name, ai0201: .values.ai0201}'
```

## Traps

- **Find the code first** (the **regionalatlas-catalog** skill): pass `code`
  (`AI002-1-5`) or `table` (`ai002_1_5`). An unknown code is a usage error (exit 2) — it
  is validated against the catalogue before any query runs.
- **`--year` must be one the indicator offers** (else exit 2, and the error lists the
  `Available:` years). The `years` range from `regionalatlas indicators` shows only
  first–last and hides gaps (`AI005` `1998–2025` has only election years).
- **Leaving out `--year` uses the newest catalogue year, which may not be loaded yet.**
  The CLI then prints `[]`, exits 0 and writes a `Note:` on stderr naming the previous
  year (on 2026-09-15 `AI013-1` gave `[]` for 2026 and all 400 Kreise with `--year 2025`).
  On an empty result, rerun with the year the note names and tell the user which year the
  map shows.
- **`--fields` are the value columns** (e.g. `ai0201`) — inspect one row's `values` keys
  first; unknown names are ignored. `--region` filters client-side (a name substring or
  an AGS).
- **Value columns are unlabelled.** `values` keys are bare column codes (`ai0501`…`ai0507`
  for `AI005`, `ai0306`/`ai0307` for `AI003-3`), and nothing the CLI prints says what a
  column measures or its unit. Don't infer a column's meaning from its code order or the
  size of its numbers. With one column, use it; with several, name the code you used and
  tell the user the CLI can't confirm the label (the interactive Regionalatlas at
  regionalatlas.statistikportal.de names each column) instead of guessing.
- **`--level gemeinde` returns many thousands of rows** — project with `--fields`, pipe
  to `jq`, and consider a coarser level unless you truly need Gemeinden.
- **`null` values** mean the indicator has no figure for that region/year.
- To compare a few named regions side by side → the **regionalatlas-compare** skill.
- Cite the source: © Statistische Ämter des Bundes und der Länder (dl-de/by-2.0).
