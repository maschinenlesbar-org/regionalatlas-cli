# Developing `regionalatlas-cli`

Architecture, testing, and the specifics of the Regionalatlas Deutschland. Read this
before changing the client or CLI.

## What this is

A typed client + CLI over the **Regionalatlas Deutschland** of the Statistische Ämter
des Bundes und der Länder, part of the `*-cli` family. It follows the shared two-layer
blueprint (a dependency-free `client/` usable as a library, and a commander `cli/` over
it) with the family's two test seams.

## Commands

```bash
npm install
npm run build       # tsc -> dist/
npm run typecheck   # tsc --noEmit
npm test            # pretest builds, then `node --test dist/test/*.test.js`
npm start -- --help
```

## Layout

```
src/
  client/        # typed API client, usable independently of the CLI
    types.ts     # geo levels, catalogue types, ArcGIS query envelope, RegionRow
    query.ts     # dependency-free query-string builder
    http.ts      # Transport interface + default node:http/https transport
    engine.ts    # URL building (data host + absolute catalogue URL), GET, retry, decode
    errors.ts    # RegionalatlasError / …ApiError / …NetworkError / …ValidationError / …ParseError
    levels.ts    # geo-level (typ) allowlist: friendly name/alias -> {1,2,3,5}
    catalog.ts   # services.json parsing/filtering + the indicator/year allowlist resolvers
    sql.ts       # builds the dynamicLayer SQL from ONLY validated pieces (the guard)
    client.ts    # RegionalatlasClient (themes / indicators / query) + row parsing/filtering
    index.ts
  cli/
    io.ts        # injectable I/O (CliDeps / CliIO) — no env seam (no auth)
    shared.ts    # option parsers (--level, --year, --fields, http-url), global->engine mapping, render
    commands/regions.ts  # themes / indicators / query
    program.ts   # assembles the commander program
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
  index.ts       # library entry
```

## TWO upstream hosts (the repo-specific divergence)

Most siblings hit one host. The Regionalatlas needs **two**, and the client keeps them
apart:

### (A) Data — the ArcGIS `dynamicLayer` query

```
GET https://www.gis-idmz.nrw.de/arcgis/rest/services/stba/regionalatlas/MapServer/dynamicLayer/query
```

This is the engine's `baseUrl` (default `https://www.gis-idmz.nrw.de`). The query
params are `layer=<urlencoded JSON>`, `f=json`, `outFields=*`, `returnGeometry=false`,
`where=1=1`, `spatialRel=esriSpatialRelIntersects`. The `layer` JSON embeds a **raw SQL
join** in a `queryTable` data source:

```sql
SELECT * FROM verwaltungsgrenzen_gesamt
LEFT OUTER JOIN <TABLE> ON ags = ags2 and jahr = jahr2
WHERE typ = <TYP> AND jahr = <YEAR> AND (jahr2 = <YEAR> OR jahr2 IS NULL)
```

- `<TYP>` is the geo level integer (1 = Bundesländer, 2 = Regierungsbezirke,
  3 = Kreise/kreisfreie Städte, 5 = Gemeinden).
- `<YEAR>` is a 4-digit year. `<TABLE>` is the indicator table code.

The response is Esri JSON: `{fields:[…], features:[{attributes:{…}}]}`. Feature
attributes are `id, typ, ags, jahr, gen` (the region) plus `jahr2, ags2, gen2` (the
joined side — `gen2` is **leading-space padded**, so it is trimmed) plus the indicator
value fields (e.g. `ai0201`) and their `<field>v` variants.

A `<field>v` column is **not** a precision flag (this file said so until
2026-09-17, and the client dropped them on that basis): it is the year-on-year
**Veränderungsrate** of the matching field, a published value the catalogue names
and gives a unit for — percent, or **percentage points** for a share indicator.
Verified against Bremen `AI002-1-5`: `ai0208` 21.4 (2022) → 22.3 (2023) with
`ai0208v` = 0.9 PP. 12 such columns exist over 9 indicators, and for `AI013-1`,
`AI-N-10`, `AI-N-12`, `AI-S-03` and `AI002-4-5` they are half the indicator.
`parseRow` therefore keeps every non-join column.

**Special-value codes.** The upstream writes the table symbols as numbers above
2,000,000,000: `2222222222` nichts vorhanden, `5555555555` Wert geheim zu halten,
`6666666666` Aussage nicht sinnvoll, `7777777777` Wert nicht sicher genug, `8888888888`
Angabe fällt später an (codes and labels from the web app's `app/js/modulRendern.js`,
which also treats every value above 2,000,000,000 as such a class; checked 2026-09-26).
Seen live: `AI005` 1998 `ai0507` (no AfD yet) and `AI002-1-5` 2000 (`ai0202`, and the
`v` columns of the first year). `parseRow` turns them into `null` and records the reason
in `RegionRow.missing` (`SPECIAL_VALUES`, `specialValueReason`); no catalogue column is a
total that could reach the threshold.

### (B) Catalogue — the indicator list

```
GET https://regionalatlas.statistikportal.de/taskrunner/services.json
```

This is the engine's `catalogUrl` (fetched via `getJsonAbsolute`, a full URL, so it does
**not** disturb the data `baseUrl`). It is a JSON array of **21 themes**, each with
`children` indicators (**70 total**): `{code, title_short, title_long, timestamp,
years:{ "2020": […], … }}`. The SQL table name is derived from the code:
`code.toLowerCase().replace(/-/g,"_")` (`"AI002-1-5"` → `ai002_1_5`). An indicator's
available years are `Object.keys(child.years)`.

The catalogue is fetched once and cached per client instance (a `query` needs it to
resolve the indicator).

## THE injection guard (repo-specific, security-critical)

The data query embeds **raw SQL** the server executes. To prevent SQL/query injection,
every value that enters the SQL is validated **before any SQL string is built**, and
no raw user text is ever interpolated:

1. **Indicator → catalogue allowlist** (`catalog.ts › resolveIndicator`). The user's
   indicator string is accepted only if it matches a catalogue entry — either the code
   form (`AI002-1-5`, case-insensitive) or the table form (`ai002_1_5`). If not found,
   a typed `RegionalatlasValidationError` is thrown **before** the SQL is built and no
   data request is made. The `<TABLE>` interpolated into SQL is **always** the matched
   `Indicator.table` (lowercase `[a-z0-9_]+`), never raw user text.
2. **Level → typ** (`levels.ts › resolveLevel`). A friendly name/alias maps to one of
   the fixed integers `{1,2,3,5}`; an unknown level → typed usage error. Only the
   integer `typ` enters SQL.
3. **Year** (`catalog.ts › resolveYear`). Omitted → the indicator's **latest** catalogue
   year (which the data host may not have loaded yet; the CLI then notes the empty result
   on stderr and names the previous year).
   Provided → must be an integer AND present in the indicator's catalogue years, else a
   typed error. Only the validated integer enters SQL.
4. **`--region` / `--fields` never touch the request.** The client always requests
   `outFields=*` and does region filtering + field projection **client-side**
   (`filterByRegion`, `projectFields`). Region: numeric → exact `ags` match ignoring
   leading zeros; else case-insensitive substring on the name. Fields: keep only the
   named value fields (unknown names ignored).
5. **Defence in depth** (`sql.ts`). Right before interpolation, `buildSql` re-asserts
   the table matches `^[a-z0-9_]+$`, the typ is one of `{1,2,3,5}`, and the year is a
   4-digit integer — so a future refactor cannot route unvalidated text into SQL.

The tests prove: a bogus/injection-shaped indicator is rejected and **never reaches the
data transport**; an out-of-range or non-integer year is rejected; an unknown level is
rejected; and the built SQL contains only the allowlisted table plus the integer
typ/year (no `;`, `--`, or quotes).

## ArcGIS specifics

- **Logical errors are HTTP 200 with `{"error":{code,message,details}}`** (verified
  live — a malformed query returns HTTP 200, not a 4xx). The client **sniffs for a
  top-level `error` key in the 2xx body** and throws `RegionalatlasApiError`
  (`arcgisCode` set) — it does not rely on the HTTP status alone. The `error.message`
  is run through `sanitizeServerText` (control-char strip) before it can reach stderr.
- The data query uses `spatialReference.wkid = 25832` (ETRS89 / UTM 32N) in the layer,
  and `returnGeometry=false` (we only need attributes).

## Testing

`node --test` on `dist/test/`. No network in the suite — a mock `Transport` routes by
host (catalogue vs data). Coverage highlights:

- `catalog.test.ts` — table derivation, theme/indicator parsing, the three filters, and
  the indicator/year allowlist resolvers (accept code & table forms; reject bogus).
- `sql.test.ts` — the exact SQL string, that it contains only the allowlisted table +
  integer typ/year, and the defence-in-depth asserts (bad table/typ/year rejected).
- `levels.test.ts` — the friendly-name → typ mapping and unknown-level rejection.
- `client.test.ts` — the guard end-to-end (bogus indicator/level/year never reaches the
  data host), row parsing (trim `gen2`, keep `<field>v`, strict value coercion), the
  malformed-feature guards, client-side region/field, and
  the ArcGIS-error-in-200-body → typed error mapping (incl. control-char stripping).
- `cli.test.ts` — the three commands, `--level`/`--year` parse-time validation, the
  guard exit codes, and the hardening guards (control-char UA, empty/non-http URL,
  bounded retries, option-shaped filter values).
- `engine.test.ts` — URL building for both hosts, the retry ladder incl. `Retry-After`,
  the scheme guard, and JSON decoding/error mapping.

## Conventions to keep

- **Zero runtime HTTP deps**; strict TS + ESM; passes on Node 20/22/24.
- **Exit codes** (`run.ts`): help/version → 0; usage/validation → 2; 404 → 4;
  network → 6; other → 1. **Redirects are NOT followed** (a 3xx surfaces as an error;
  from the data host that means a base-URL misconfiguration → usage).
- **Retry/backoff:** `429`/`503` are retried up to `maxRetries` (default 2), honouring
  a `Retry-After` header in either documented form — delta-seconds or HTTP-date —
  clamped to 30 s so a server-set `Retry-After: 86400` cannot park the CLI for a day.
  A missing or unparseable header falls back to linear backoff (`retryDelayMs × attempt`).
- **Scaffold origin:** scaffolded from `ladesaeulenregister-cli` (ArcGIS, keyless,
  query.ts); rewritten for the two-host split, the catalogue allowlist, and the
  dynamicLayer SQL guard.

## Website

The project website — <https://maschinenlesbar-org.github.io/regionalatlas-cli/> in English and
<https://maschinenlesbar-org.github.io/regionalatlas-cli/de/> in German — is built from `site/`
with [Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web components
and [Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the TypeDoc API
reference under `/api/`. Its content comes from this repository: the README intro and quick
start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`), `Usage.md`,
`GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill examples in
`EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are `site/_config.yml` and
`site/_data/project.yml` (the German intro and the access requirements); the rest of `site/` is
identical in every maschinenlesbar.org CLI, so change it in all of them together. When the
README intro changes, update the German intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/regionalatlas-cli/
```
