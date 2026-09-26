# Usage

`regionalatlas` — a CLI for the Regionalatlas Deutschland (Statistische Ämter des
Bundes und der Länder). No API key needed.

```bash
regionalatlas [global options] <command> [command options]
```

## Global options

| Option | Description |
|---|---|
| `--base-url <url>` | ArcGIS data host base URL (default `https://www.gis-idmz.nrw.de`) |
| `--catalog-url <url>` | indicator catalogue URL (default the statistikportal.de `services.json`) |
| `--timeout <ms>` | time limit per request in ms, whole response included (0 = no timeout; at most 2147483647) |
| `--user-agent <ua>` | User-Agent header value |
| `--max-retries <n>` | retries for transient 429/503 responses (0..10) |
| `--max-response-bytes <n>` | cap the response body size in bytes (0 = unlimited; default 100 MiB) |
| `--compact` | print JSON on a single line (for piping to `jq`) |
| `-V, --version` / `-h, --help` | version / help |

`--base-url` and `--catalog-url` accept only `http:`/`https:` URLs. `--base-url` must
not have a query (`?`) or fragment (`#`) or surrounding whitespace (the CLI appends the
data path to it); a path prefix for a mirror is fine. A `user:password@` part is sent as
Basic auth and shown as `***@` in error messages.

## Commands

### `themes` — list the subject areas

`regionalatlas themes` → `[{ title, indicatorCount }, …]` (the 21 Themenbereiche).

### `indicators` — list indicators

| Option | Description |
|---|---|
| `--theme <substr>` | filter by theme title (case-insensitive substring) |
| `--year <yyyy>` | only indicators offering this year |
| `--search <substr>` | filter over code + short + long title (case-insensitive) |

`regionalatlas indicators` → `[{ code, table, theme, titleShort, titleLong, years }, …]`,
where `years` is a compact range (e.g. `2000–2024`). `titleLong` is the catalogue's long
title, which `--search` also matches (it contains the theme name).

### `query <indicator-code>` — fetch data rows

| Option | Description |
|---|---|
| `--level <level>` | geo level: `land` \| `regierungsbezirk` \| `kreis` \| `gemeinde` (default `land`) |
| `--year <yyyy>` | reporting year (default: the newest year in the catalogue, which may not be loaded yet — see below) |
| `--region <name\|ags>` | keep only rows matching a name substring or an AGS |
| `--fields <a,b,c>` | keep only these value fields (comma-separated; repeating the option adds to the list); names are checked against the indicator's columns |

The positional `<indicator-code>` accepts the code form (`AI002-1-5`) or the table
form (`ai002_1_5`), case-insensitively. Output is `[{ ags, name, typ, level, year,
values }, …]`, one row per region. A value the upstream sent as a special-value code
(`2222222222` = nichts vorhanden, `6666666666` = Aussage nicht sinnvoll, …; see
[GLOSSARY.md](GLOSSARY.md)) is `null`, and the row then carries a `missing` object naming
the reason per field.

`--level` accepts these aliases: `land`/`laender`/`bundesland` (=1),
`regierungsbezirk`/`rb` (=2), `kreis`/`kreise`/`landkreis` (=3),
`gemeinde`/`gemeinden` (=5).

Every level covers **all of Germany**, filling in with the next coarser unit where the
finer one does not exist — so `ags` length varies within a level. `regierungsbezirk`
returns 38 rows: the 29 actual Regierungsbezirke plus the 9 Bundesländer that have
none. `kreis` (400) and `gemeinde` (~11 000) carry Berlin and Hamburg at 2 digits, and
`gemeinde` carries 104 kreisfreie Städte at their 5-digit Kreis key. Each level is a
non-overlapping partition, so summing or mapping one is safe; counting its rows as
"the Regierungsbezirke of Germany" is not.

Not every indicator is published at every level: `AIGG-01` (Gesundheitsausgaben) exists
only per Land, `AI005` (Bundestagswahl) not per Gemeinde, and some years have no figures at
all. The catalogue records which levels have figures in each year, and `query` refuses a
level without any (exit 2, before the data request), naming the published levels and the
years that do have figures at the requested one — the data host would otherwise return a
row for every region with every value `null`. `--region` and `--fields` are applied **client-side** (they
never enter the upstream request), but a `--fields` name is validated against the
indicator's value columns first — `indicators` lists them with their titles and units.

An empty result prints `[]`, exits 0 and explains itself on stderr, by cause: either the
data host returned no rows for the indicator, level and year, or it did and no row matched
`--region` (the note then says how many rows there were, and gives no year hint). The catalogue can list
a newest year the data host has not loaded yet: on 2026-09-15 `AI013-1` listed 2026, and
`query AI013-1 --level kreis` returned `[]`, while `--year 2025` returned all 400
Kreise. When the year was defaulted, the note names the previous catalogue year to
try.

## Examples

```bash
regionalatlas themes --compact | jq '.[].title'
regionalatlas indicators --search bevölkerung
regionalatlas indicators --theme Wahlen --year 2021
regionalatlas query AI002-1-5 --level land --year 2020                 # 16 Bundesländer
regionalatlas query AI002-1-5 --level kreis                            # ~400 Kreise, latest year
regionalatlas query AI002-1-5 --level land --region Bayern --compact
regionalatlas query AI002-1-5 --level land --fields ai0201 --compact | jq '.[] | {name, values}'
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success (help/version included); an empty result also exits 0, with a `Note:` on stderr — from `query` and from `indicators` alike |
| `1` | API/logical error (the ArcGIS `error` envelope), or a catch-all |
| `2` | usage / validation error (bad flags, unknown command, **unknown indicator**, unknown `--level`, a `--level` the indicator has no figures at in that year, a `--year` outside the indicator's range, an unknown `--fields` column, a non-`http(s)` or malformed `--base-url`/`--catalog-url`, a `--base-url` with a query, fragment or surrounding whitespace, redirecting base URL) |
| `4` | HTTP 404 |
| `6` | network / transport failure (DNS, connection, timeout, response size-cap) |

## Notes

- **The indicator, level, year and `--fields` columns are validated against the catalogue
  before any query is built** — an unknown indicator is a usage error (exit 2) and never reaches the
  server. See the injection-guard section in [DEVELOPING.md](DEVELOPING.md).
- **The ArcGIS server reports logical errors as HTTP 200 with an `error` object** — the
  CLI detects it and exits 1 with the message.
- **A result cut off at the server's record limit** (`exceededTransferLimit`, set above
  2,000,000 rows today) is printed with a `Note:` on stderr saying it is incomplete.
- **Two hosts:** the data query hits `--base-url` (ArcGIS); the indicator list hits
  `--catalog-url` (statistikportal.de). Both are keyless.
- The data is © the Statistische Ämter des Bundes und der Länder under **dl-de/by-2.0**
  — see [DATA_LICENSE.md](DATA_LICENSE.md); attribution is required.
