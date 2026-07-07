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
| **typ / geo level** | `--level` | The geographic aggregation level. `land`=1 (Bundesländer, 16), `regierungsbezirk`/`rb`=2, `kreis`/`landkreis`=3 (Kreise/kreisfreie Städte, ~400), `gemeinde`=5 (Gemeinden). |
| **AGS** (Amtlicher Gemeindeschlüssel) | `ags` | The official regional key of a Land/Kreis/Gemeinde (a string, e.g. `03` for Niedersachsen, `03361` for a Kreis). Leading zeros matter — `--region` ignores them for numeric matches. |
| **Gebietsname** | `name` | The region name (`gen` in the data), e.g. `Niedersachsen`, `Bremen`. |
| **jahr / year** | `--year`, `year` | The reporting year (a 4-digit integer). Each indicator offers a specific set of years; omit `--year` for the latest. |
| **value field** | `values` | An indicator value column (e.g. `ai0201`) — a number or `null`. `--fields` keeps only named ones. |
| **precision-flag `v` field** | (dropped) | A `<field>v` variant (e.g. `ai0201v`) flags the precision/quality of the matching value field. The parsed `RegionRow` drops these so `values` holds only the measured values. |
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
