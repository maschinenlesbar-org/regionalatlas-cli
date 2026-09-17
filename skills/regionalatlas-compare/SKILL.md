---
name: regionalatlas-compare
description: >
  Compare a Regionalatlas Deutschland indicator across specific regions using the
  regionalatlas-cli. Trigger when the user asks "compare Bayern and Sachsen on
  indicator X", "how does this Kreis rank against the others?", "value for Berlin vs
  Hamburg vs Bremen", "which Bundesland has the highest / lowest X?", or wants a few
  named regions (or a single one) picked out and set side by side. Fetches the
  indicator at the right level and filters to the regions of interest.
version: 1.0.0
userInvocable: true
---

# Regionalatlas Compare (indicator across regions)

Pick out **specific regions** and set an indicator side by side — one region, a
handful, or the extremes of the whole set.

## Tooling

This skill drives the `regionalatlas` command. **Before anything else, validate it is available** — run `command -v regionalatlas` (or `regionalatlas --version`). If it is not on your PATH, STOP and inform the user that the `regionalatlas` CLI (`@maschinenlesbar.org/regionalatlas-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**No API key is required.** `regionalatlas query <code> --level <land|regierungsbezirk|kreis|gemeinde> [--year …] [--region …] [--fields …]` returns one row per region; `--region` picks a region by name substring or AGS. `--compact` for `jq`. Data © Statistische Ämter des Bundes und der Länder under Datenlizenz Deutschland – Namensnennung 2.0 (dl-de/by-2.0, attribution required) — see DATA_LICENSE.md.

## How to compare

`--region` selects **one** region per call (a name substring, or an AGS — numeric
matches ignore leading zeros). To compare **several** regions, either run one call per
region, or fetch the whole level once and filter with `jq` (fewer requests):

| Field to compare on | Where it is |
|---|---|
| region name | `name` (e.g. `Bayern`) |
| region key | `ags` (e.g. `09` for Bayern, `03361` for a Kreis) — use it to pick Kreise and Gemeinden |
| the number(s) | `values.<field>` (e.g. `values.ai0201`) |

## Recipes

```bash
# One region
regionalatlas query AI002-1-5 --level land --region Bayern --compact | jq '.[0].values'

# A few named regions, side by side (one fetch, filter with jq)
regionalatlas query AI002-1-5 --level land --fields ai0201 --compact \
  | jq '[.[] | select(.name|test("Berlin|Hamburg|Bremen"))] | map({name, ai0201: .values.ai0201})'

# Highest / lowest across the whole level
regionalatlas query AI002-1-5 --level land --fields ai0201 --compact \
  | jq 'sort_by(.values.ai0201) | {lowest: .[0]|{name, v:.values.ai0201}, highest: .[-1]|{name, v:.values.ai0201}}'

# Kreise by AGS: a city name also matches its Landkreis ("München" gives 09162 München
# and 09184 München, Landkreis), so pick the exact keys
regionalatlas query AI-S-01 --level kreis --compact \
  | jq '[.[] | select(.ags|IN("09162","14713"))] | map({ags, name, values})'

# Compare one Kreis against the level average
regionalatlas query AI002-1-5 --level kreis --fields ai0201 --compact \
  | jq '{avg: ([.[].values.ai0201|select(.!=null)]|add/length), verden: (.[]|select(.name=="Verden")|.values.ai0201)}'
```

## Traps

- **Same level for all regions being compared** — you can't mix a Land and a Kreis in
  one call; pick the `--level` that holds all the regions you want.
- **A level fills in with coarser units where a finer one does not exist**, so `ags`
  length varies within it. `regierungsbezirk` returns 38 rows — 29 Regierungsbezirke
  plus the 9 Bundesländer that have none — and `kreis`/`gemeinde` carry Berlin and
  Hamburg at 2 digits. Each level is still a complete, non-overlapping cover of
  Germany, so a rank or an average over one is sound; just don't call all 38 rows
  Regierungsbezirke.
- **`--region` is one selector per call** — for many regions, fetch the level once and
  filter with `jq` rather than N requests.
- **A city name also matches its Landkreis.** `--region München` at `--level kreis`
  returns `09162 München` and `09184 München, Landkreis` (same for Leipzig: `14713` /
  `14729`), and a `test("…")` jq filter does the same. At Kreis and Gemeinde level, check
  the names you got, then compare by `ags`.
- **Pick a value field** (`--fields ai0201`) so the comparison is on a single number.
  Get the column names and what they measure from `indicators` (each row carries a
  `fields` list of `{code, title, unit}`) — the codes do not follow the indicator code
  (`AI-S-01` returns `ai1601`) and the suffix carries no meaning (`AI005` has `ai0507`
  for AfD and `ai0506` for Wahlbeteiligung). An unknown name is a usage error (exit 2)
  listing the valid ones.
- **`values` keys are bare column codes — `indicators` says what they mean.** Each
  indicator row carries a `fields` list of `{code, title, unit}` in the order the data
  host returns the columns. Read the label and unit from there, and name both when
  reporting a comparison; never infer a column's meaning from its code order or the
  size of its numbers. `AI005` is the cautionary case: `ai0507` is the AfD share and
  `ai0506` is Wahlbeteiligung.
- **Watch `null`** — a region with no figure sorts oddly; filter `select(.!=null)`
  before `min`/`max`/`avg`.
- **Same `--year` across regions** so you compare like with like. Leaving it out uses the
  newest catalogue year, which may not be loaded yet: the CLI then prints `[]` with a
  `Note:` on stderr naming the previous year to use.
- To dump the whole level for a map → the **regionalatlas-map** skill; to find the code
  → the **regionalatlas-catalog** skill.
- Cite the source: © Statistische Ämter des Bundes und der Länder (dl-de/by-2.0).
