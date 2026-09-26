# Glossary

Regionalatlas terms and fields, as the CLI surfaces them.

| Term | In the CLI | What it is |
|---|---|---|
| **Regionalatlas Deutschland** | — | The regional-statistics map/indicator collection of the Statistische Ämter des Bundes und der Länder. |
| **Regionaldatenbank Deutschland** | data source | The underlying regional-statistics database (GENESIS, `regionalstatistik.de`) the indicators draw on. |
| **Themenbereich (theme)** | `themes` | A subject area, e.g. `Bevölkerung`, `Wahlen`, `Umwelt`. There are **21**. |
| **Indikator (indicator)** | `indicators`, `query <code>` | A single measurable variable, identified by a **code** (e.g. `AI002-1-5`). There are **70**. |
| **code** | `AI002-1-5` | The catalogue identifier for an indicator (accepted case-insensitively, hyphen or underscore). |
| **table code** | `ai002_1_5` | The SQL table name derived from the code: `code.toLowerCase().replace(/-/g,"_")`. Also accepted by `query`. |
| **typ / geo level** | `--level` | The geographic aggregation level. `land`=1 (Bundesländer, 16), `regierungsbezirk`/`rb`=2 (38 rows), `kreis`/`landkreis`=3 (400 rows), `gemeinde`=5 (~11 000 rows). Every level covers **all of Germany** — see *level fill-in*. |
| **level fill-in** | `ags` length | Where a finer unit does not exist, a level fills in with the next coarser one, so each level is a complete, non-overlapping cover of Germany and `ags` length varies within it. `regierungsbezirk` returns 38 rows: the **29** actual Regierungsbezirke (3-digit AGS) plus the **9 Bundesländer that have none** (2-digit: Schleswig-Holstein, Hamburg, Bremen, Saarland, Berlin, Brandenburg, Mecklenburg-Vorpommern, Sachsen-Anhalt, Thüringen). `kreis` and `gemeinde` carry Berlin (`11`) and Hamburg (`02`) at 2 digits; `gemeinde` also carries 104 kreisfreie Städte at their 5-digit Kreis key. So "the 38 Regierungsbezirke" is wrong, but summing or mapping a level is safe. |
| **AGS** (Amtlicher Gemeindeschlüssel) | `ags` | The official regional key of a Land/Kreis/Gemeinde (a string, e.g. `03` for Niedersachsen, `03361` for a Kreis). Leading zeros matter — `--region` ignores them for numeric matches. |
| **Gebietsname** | `name` | The region name (`gen` in the data), e.g. `Niedersachsen`, `Bremen`. |
| **jahr / year** | `--year`, `year` | The reporting year (a 4-digit integer). Each indicator offers a specific set of years, often with gaps that the first–last range from `indicators` (e.g. `1998–2025` for `AI005`) doesn't show. Leaving out `--year` uses the newest catalogue year, which the data host may not have loaded yet: `query` then returns `[]` and notes it on stderr. |
| **value field** | `values` | An indicator value column (e.g. `ai0201`) — a number or `null`. `--fields` keeps only named ones (case-insensitive, `-` and `_` alike). `indicators` lists every column of an indicator with its title and unit, under the key it has in `values` — the Zensus 2011 indicators' catalogue writes `AI-Z01`, the data host `ai_z01`, and the CLI uses `ai_z01` for both. |
| **Veränderungsrate (`v` field)** | `values` | A `<field>v` column (e.g. `ai0201v`) is the year-on-year **rate of change** of the matching value field — a published value in its own right, not a precision flag. Its unit is **percent**, or **percentage points** for a share indicator (`ai0208v`); `indicators` gives the unit per column. |
| **gen2 / ags2 / jahr2** | (internal) | The joined side of the SQL `LEFT OUTER JOIN`. `gen2` is leading-space padded in the raw data — the client trims it; the parsed row uses `gen`/`ags`/`jahr`. |
| **dynamicLayer / queryTable** | (internal) | The ArcGIS mechanism that runs the raw SQL join behind `query`. |
| **`--base-url` / `--catalog-url`** | options | The ArcGIS data host / the indicator catalogue URL (the two upstream hosts). |

## Reading the data

- **`query` returns one row per region** at the chosen `--level`: `{ ags, name, typ,
  level, year, values }`.
- **A `null` value** means the indicator has no figure for that region/year.
- **It joins geography to statistics** — every region present at the level appears; a
  region with no indicator row still appears (its `values` are `null`), thanks to the
  `LEFT OUTER JOIN`.
- **The indicator catalogue is the allowlist** — only catalogued codes/tables can be
  queried; use `indicators` to discover them.
