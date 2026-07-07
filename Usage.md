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
| `--timeout <ms>` | per-request timeout in ms (0 = no timeout) |
| `--user-agent <ua>` | User-Agent header value |
| `--max-retries <n>` | retries for transient 429/503 responses (0..10) |
| `--max-response-bytes <n>` | cap the response body size in bytes (0 = unlimited; default 100 MiB) |
| `--compact` | print JSON on a single line (for piping to `jq`) |
| `-V, --version` / `-h, --help` | version / help |

`--base-url` and `--catalog-url` accept only `http:`/`https:` URLs.

## Commands

### `themes` — list the subject areas

`regionalatlas themes` → `[{ title, indicatorCount }, …]` (the 21 Themenbereiche).

### `indicators` — list indicators

| Option | Description |
|---|---|
| `--theme <substr>` | filter by theme title (case-insensitive substring) |
| `--year <yyyy>` | only indicators offering this year |
| `--search <substr>` | filter over code + short + long title (case-insensitive) |

`regionalatlas indicators` → `[{ code, table, theme, titleShort, years }, …]`, where
`years` is a compact range (e.g. `2000–2024`).

### `query <indicator-code>` — fetch data rows

| Option | Description |
|---|---|
| `--level <level>` | geo level: `land` \| `regierungsbezirk` \| `kreis` \| `gemeinde` (default `land`) |
| `--year <yyyy>` | reporting year (default: the indicator's latest available) |
| `--region <name\|ags>` | keep only rows matching a name substring or an AGS |
| `--fields <a,b,c>` | keep only these value fields (comma-separated) |

The positional `<indicator-code>` accepts the code form (`AI002-1-5`) or the table
form (`ai002_1_5`), case-insensitively. Output is `[{ ags, name, typ, level, year,
values }, …]`, one row per region.

`--level` accepts these aliases: `land`/`laender`/`bundesland` (=1),
`regierungsbezirk`/`rb` (=2), `kreis`/`kreise`/`landkreis` (=3),
`gemeinde`/`gemeinden` (=5). `--region` and `--fields` are applied **client-side** (they
never enter the upstream request).

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
| `0` | success (help/version included); an empty result also exits 0 |
| `1` | API/logical error (the ArcGIS `error` envelope), or a catch-all |
| `2` | usage / validation error (bad flags, unknown command, **unknown indicator**, unknown `--level`, a `--year` outside the indicator's range, a non-`http(s)` or malformed `--base-url`/`--catalog-url`, redirecting base URL) |
| `4` | HTTP 404 |
| `6` | network / transport failure (DNS, connection, timeout, response size-cap) |

## Notes

- **The indicator, level, and year are validated against the catalogue before any query
  is built** — an unknown indicator is a usage error (exit 2) and never reaches the
  server. See the injection-guard section in [DEVELOPING.md](DEVELOPING.md).
- **The ArcGIS server reports logical errors as HTTP 200 with an `error` object** — the
  CLI detects it and exits 1 with the message.
- **Two hosts:** the data query hits `--base-url` (ArcGIS); the indicator list hits
  `--catalog-url` (statistikportal.de). Both are keyless.
- The data is © the Statistische Ämter des Bundes und der Länder under **dl-de/by-2.0**
  — see [DATA_LICENSE.md](DATA_LICENSE.md); attribution is required.
