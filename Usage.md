# Usage

`regionalatlas` — a CLI for the Regionalatlas Deutschland (Statistische Ämter des
Bundes und der Länder). No API key needed.

```bash
regionalatlas [global options] <command> [command options]
```

## Global options

| Option | Description |
|---|---|
| `--base-url <url>` | ArcGIS data host base URL (default: the `REGIONALATLAS_BASE_URL` environment variable, else `https://www.gis-idmz.nrw.de`) |
| `--catalog-url <url>` | indicator catalogue URL (default the statistikportal.de `services.json`) |
| `--timeout <ms>` | time limit per request in ms, whole response included (0 = no timeout; at most 2147483647) |
| `--user-agent <ua>` | User-Agent header value (not blank; no control characters or characters above U+00FF) |
| `--max-retries <n>` | retries for transient 429/503 responses and reset connections (0..10); a refused connection, a DNS failure and a timeout are not retried. Each retry waits a linear backoff (200 ms, 400 ms, …), or the server's `Retry-After` when that is longer (capped at 30 s) — never less, so `Retry-After: 0` still waits the backoff |
| `--max-response-bytes <n>` | cap the response body size in bytes (0 = unlimited; default 100 MiB). Every command reads the indicator catalogue (about 2 MB) first, so a cap below that fails even `themes`; the error says which download was too big |
| `--compact` | print JSON on a single line (for piping to `jq`) |
| `-V, --version` / `-h, --help` | version / help |

Every option takes one value, except `--fields`, which is repeatable (`--fields a --fields b`
is `--fields a,b`); giving any other option twice is a usage error (exit 2), where the last
value used to win silently.

`--base-url` and `--catalog-url` accept only `http:`/`https:` URLs without whitespace
(around or inside them). `--base-url` must not have a query (`?`) or fragment (`#`) (the
CLI appends the data path to it); a path prefix for a mirror is fine. A `user:password@`
part is sent as Basic auth and shown as `***@` in everything the CLI prints — its own error
messages, commander's usage errors (which quote a rejected value), help — whatever
characters the password contains. A `%` in the user name or password must start an escape
(write a literal `%` as `%25`); a bare one is a usage error (exit 2). The library checks `baseUrl` and `catalogUrl` by the
same rules when the client is built.

`--catalog-url` may carry a query, and a `token` (or `access_token`) parameter in it is
treated as a credential: ArcGIS services take their access token as `?token=…`, so a mirror
behind such a login works as `--catalog-url 'https://mirror.example/services.json?token=…'`.
The token is sent only with the catalogue request — never to the data host (`--base-url`
takes no query), and redirects are not followed — and everything the CLI prints shows it as
`token=***`. The public catalogue needs none.

`REGIONALATLAS_BASE_URL` sets the data host's base URL for every run (a mirror, a local
fixture server); `--base-url` overrides it, and an empty variable counts as unset. Its value
is checked by the same rules before any request: a bad one is a usage error (exit 2) that
names the variable, not its value (`error: REGIONALATLAS_BASE_URL: Only http: and https:
URLs are supported. Fix or unset the variable.`). Help works whatever it holds, and a
password in it is redacted like one in `--base-url`.

## Commands

### `themes` — list the subject areas

`regionalatlas themes` → `[{ title, indicatorCount }, …]` (the 21 Themenbereiche).

### `indicators` — list indicators

| Option | Description |
|---|---|
| `--theme <substr>` | filter by theme title (case-insensitive substring) |
| `--year <yyyy>` | only indicators offering this year (in `years`; a few offered years have no figures at any level — their `levels` entry is `[]`) |
| `--search <substr>` | filter over code + short + long title (case-insensitive; a decomposed umlaut matches too, as for `--theme` and `--region`) |

`regionalatlas indicators` → `[{ code, table, theme, titleShort, titleLong, years, levels, fields }, …]`,
where `years` lists every year offered (e.g. `["2000", "2005", …]`, gaps included), `levels` maps
each year to the geo levels with figures, and `fields` lists the value columns a
`query` returns as `{ code, title, unit }`, `code` being the key in `values`. `titleLong` is the catalogue's long
title, which `--search` also matches (it contains the theme name).

### `query <indicator-code>` — fetch data rows

| Option | Description |
|---|---|
| `--level <level>` | geo level: `land` \| `regierungsbezirk` \| `kreis` \| `gemeinde` (default `land`) |
| `--year <yyyy>` | reporting year (default: the newest year in the catalogue, which may not be loaded yet — see below) |
| `--region <name\|ags>` | keep only the region with this AGS, or this exact name — else every region whose name contains the text (see below) |
| `--fields <a,b,c>` | keep only these value fields (comma-separated; repeating the option adds to the list); names are checked against the indicator's columns |

The positional `<indicator-code>` accepts the code form (`AI002-1-5`) or the table
form (`ai002_1_5`), case-insensitively. Output is `[{ ags, name, typ, level, year,
values }, …]`, one row per region. A value the upstream sent as a special-value code
(`2222222222` = nichts vorhanden, `6666666666` = Aussage nicht sinnvoll, …; see
[GLOSSARY.md](GLOSSARY.md)) is `null`, and the row then carries a `missing` object naming
the reason per field.

`--level` accepts these aliases: `land`/`laender`/`länder`/`bundesland`/`bundesländer` (=1),
`regierungsbezirk`/`rb` (=2), `kreis`/`kreise`/`landkreis` (=3),
`gemeinde`/`gemeinden` (=5) — case-insensitively, with surrounding spaces ignored and an
umlaut typed decomposed (as macOS input can produce) read like the composed one.

Every level covers **all of Germany**, filling in with the next coarser unit where the
finer one does not exist — so `ags` length varies within a level. `regierungsbezirk`
returns 38 rows for recent years: the 29 actual Regierungsbezirke plus the 9 Bundesländer
that have none. `kreis` (400 for recent years) and `gemeinde` (~11 000) carry Berlin and
Hamburg at 2 digits, and
`gemeinde` carries 104 kreisfreie Städte at their 5-digit Kreis key. Each level is a
non-overlapping partition, so summing or mapping one is safe; counting its rows as
"the Regierungsbezirke of Germany" is not. Row counts follow the boundaries of the
reporting year: for 2000, `regierungsbezirk` has 40 rows and `kreis` 440, among them two
Kreise named Hannover (`03201`, `03253`) from before the Region Hannover — compare by
`ags`, not by name, across years.

Not every indicator is published at every level: `AIGG-01` (Gesundheitsausgaben) exists
only per Land, `AI005` (Bundestagswahl) not per Gemeinde, and some years have no figures at
all. The catalogue records which levels have figures in each year, and `query` refuses a
level without any (exit 2, before the data request), naming the published levels and the
years that do have figures at the requested one — the data host would otherwise return a
row for every region with every value `null`. `--region` and `--fields` are applied **client-side** (they
never enter the upstream request), but a `--fields` name is validated against the
indicator's value columns first — `indicators` lists them with their titles and units.

`--region` picks rows like this:

- **A number is a key** (AGS): the row whose `ags` equals it, leading zeros ignored
  (`9`, `09`). When no row has that key, the row whose shorter key it pads with zeros:
  a level carries a filled-in unit under its own short key, so the official 8-digit key
  `09162000` (München) matches the `09162` row at `gemeinde`, and `11000000` / `11000`
  Berlin's `11` row at `gemeinde` / `kreis`; a `Note:` on stderr says so.
- **Text is a name**, compared case-insensitively: the rows whose **whole name** equals it
  when there are any — `Sachsen` is Sachsen alone, not Niedersachsen and Sachsen-Anhalt
  too; `Gera` is Gera, not Groß-Gerau; `München` at `kreis` is the city (`09162`), not
  `München, Landkreis` — and a `Note:` on stderr names the rows that only contain the
  text. Without a whole-name match, every row whose name contains the text
  (`--region Neustadt` at `gemeinde`: 21 rows).
- **Several rows can still match** — a name two regions share (two Gemeinden called
  Halle; `Hannover` twice in the Kreis rows of 2000) or a part of a name. All are
  printed, and a `Note:` on stderr says the region is ambiguous and lists them; pick one
  by its `ags`. A script that wants one region should give the AGS, or check that it got
  exactly one row.

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
| `0` | success (help/version included); an empty result also exits 0, with a `Note:` on stderr — from `query` and from `indicators` alike; so does a run whose output reader stops early (`\| head`), quietly |
| `1` | API/logical error (the ArcGIS `error` envelope), or a catch-all |
| `2` | usage / validation error (bad flags, unknown command, **unknown indicator**, unknown `--level`, a `--level` the indicator has no figures at in that year, a `--year` outside the indicator's range, an unknown `--fields` column, a non-`http(s)` or malformed `--base-url`/`--catalog-url`, a `--base-url` with a query, fragment or surrounding whitespace, redirecting base URL) |
| `4` | HTTP 404 |
| `6` | network / transport failure (DNS, connection, timeout, response size-cap) |

A failed run keeps its exit code when the reader of stderr has gone away (`2>&1 | true`).

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
