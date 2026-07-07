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
| region key | `ags` (e.g. `09` for Bayern, `03361` for a Kreis) |
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

# Compare one Kreis against the level average
regionalatlas query AI002-1-5 --level kreis --fields ai0201 --compact \
  | jq '{avg: ([.[].values.ai0201|select(.!=null)]|add/length), verden: (.[]|select(.name=="Verden")|.values.ai0201)}'
```

## Traps

- **Same level for all regions being compared** — you can't mix a Land and a Kreis in
  one call; pick the `--level` that holds all the regions you want.
- **`--region` is one selector per call** — for many regions, fetch the level once and
  filter with `jq` rather than N requests.
- **Pick a value field** (`--fields ai0201`) so the comparison is on a single number;
  inspect a row's `values` keys first. Unknown field names are ignored.
- **Watch `null`** — a region with no figure sorts oddly; filter `select(.!=null)`
  before `min`/`max`/`avg`.
- **Same `--year` across regions** (omit for the latest) so you compare like with like.
- To dump the whole level for a map → the **regionalatlas-map** skill; to find the code
  → the **regionalatlas-catalog** skill.
- Cite the source: © Statistische Ämter des Bundes und der Länder (dl-de/by-2.0).
