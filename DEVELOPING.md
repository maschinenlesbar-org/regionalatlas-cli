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
npm test            # pretest builds, then `node --test --test-timeout=5000 dist/test/*.test.js`
npm start -- --help
```

## Layout

```
src/
  client/        # typed API client, usable independently of the CLI
    types.ts     # geo levels, catalogue types, ArcGIS query envelope, RegionRow
    query.ts     # dependency-free query-string builder
    validate.ts  # the library's input rules (Problem functions + assertValid)
    http.ts      # Transport interface + default node:http/https transport
    engine.ts    # URL building (data host + absolute catalogue URL), GET, retry, decode
    errors.ts    # RegionalatlasError / …ApiError / …NetworkError / …ValidationError / …ParseError
    levels.ts    # geo-level (typ) allowlist: friendly name/alias -> {1,2,3,5}
    catalog.ts   # services.json parsing/filtering + the indicator/year allowlist resolvers
    sql.ts       # builds the dynamicLayer SQL from ONLY validated pieces (the guard)
    client.ts    # RegionalatlasClient (themes / indicators / query) + row parsing/filtering
    index.ts
  cli/
    io.ts        # injectable I/O (CliDeps / CliIO), the logger and the clock — no env seam (no auth)
    log.ts       # the stderr log: records with ts, level, topic; --log-format text|jsonl
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
`v` columns of the first year). `parseRow` turns `2222222222` into `0` — the Destatis
`-`, exactly zero (`SPECIAL_VALUE_FIGURES`, `specialValueFigure`; the user's decision of
2026-10-06, it was `null` up to 0.4.0) — and every other code into `null`, and records
the code's meaning in `RegionRow.missing` either way (`SPECIAL_VALUES`,
`specialValueReason`). The upstream also writes `2222222222` for a Veränderungsrate
without a previous year (2000), where 0 is no real rate; `missing` is how a caller tells
them apart. No catalogue column is a total that could reach the threshold.

### (B) Catalogue — the indicator list

```
GET https://regionalatlas.statistikportal.de/taskrunner/services.json
```

This is the engine's `catalogUrl` (fetched via `getJsonAbsolute`, a full URL, so it does
**not** disturb the data `baseUrl`). It is a JSON array of **21 themes**, each with
`children` indicators (**71 total** on 2026-09-26): `{code, title_short, title_long, timestamp,
years:{ "2020": […], … }}`. The SQL table name is derived from the code:
`code.toLowerCase().replace(/-/g,"_")` (`"AI002-1-5"` → `ai002_1_5`). An indicator's
available years are `Object.keys(child.years)`.

The catalogue is fetched once and cached per client instance (a `query` needs it to
resolve the indicator).

`parseIndicators` leaves out what the SQL guard would refuse later: an entry whose
code is not letters/digits joined by `-`/`_`, a year key that is not four digits
without a leading zero, and a value column whose name is not `[a-z0-9_]+` after the
`-` → `_` mapping. `themes` counts the same entries `indicators` lists, and the default
year comes from the valid year keys only. `sql.ts`'s asserts throw `RegionalatlasError`
(exit 1), not a bare `Error`.

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
   The catalogue host is not trusted beyond the code shape: `parseIndicators` (and
   `parseThemes`, so every command agrees) refuses the whole catalogue with a
   `RegionalatlasParseError` (exit 1) naming the code(s) when a code's table is the
   boundary table `verwaltungsgrenzen_gesamt` (`BOUNDARY_TABLE`), or when two codes name
   the same table (`DUP-1` and `dup_1`: one would be unreachable, and which one a query
   got depended on the catalogue's order). Fail closed: no data request is made. The
   public catalogue has neither (71 codes, 71 tables on 2026-10-05).
2. **Level → typ** (`levels.ts › resolveLevel`). A friendly name/alias maps to one of
   the fixed integers `{1,2,3,5}`; an unknown level (or a non-string one) → typed usage
   error. The lookup goes through `normalizeInput` (trim, NFC; exported) and is
   case-insensitive, so a decomposed umlaut in `bundesländer` resolves; indicator codes
   and field names are normalised the same way. An omitted level is `DEFAULT_LEVEL` (`land`, exported from `levels.ts`), the
   library's default that `--level` shows as its own. Only the integer `typ` enters SQL.
   The allowlist is fixed, so `queryResult` checks the level **first**, before the
   catalogue request: an unknown indicator or a catalogue outage cannot hide a bad level.
   `--level` calls the same `resolveLevel` and reports its message as a usage error.
3. **Year** (`catalog.ts › resolveYear`). Omitted → the indicator's **latest** catalogue
   year (which the data host may not have loaded yet; the CLI then notes the empty result
   on stderr and names the previous year).
   Provided → must be an integer AND present in the indicator's catalogue years, else a
   typed error. Only the validated integer enters SQL. Then `assertLevelPublished`
   refuses a level whose catalogue `geom_levels` count is 0 for every column in that
   year (`years[year][i].geom_levels` = `[land, rb, kreis, gemeinde]` region counts): the
   data host would answer with a row per region, all `null` (live-checked 2026-09-26:
   `AI008-2` 2006 and `AI019-3-5` 2022 at `land`, 16 rows each, no figure). A year
   without usable `geom_levels` is not checked.
4. **`--region` / `--fields` never touch the request.** The client always requests
   `outFields=*` and does region filtering + field projection **client-side**
   (`filterByRegion`/`matchRegion`, `projectFields`). Region: numeric → exact `ags` match
   ignoring leading zeros, or else the row whose shorter key the input pads with zeros
   (`by: "ags-filled"`: `09162000` → the `09162` row of a kreisfreie Stadt at gemeinde,
   `11000` → Berlin's `11` at kreis; the official keys used to match nothing); else the rows whose whole name equals it (case-insensitive,
   NFC) when there are any — the substring hits are then reported as `others` — else every
   row whose name contains it. `queryResult` returns how it matched (`region.by`,
   `region.others`), and the CLI prints an `INFO` note when an exact name left rows out or when
   several rows matched (`regionNote`). A bare substring match used to put the wrong
   region first (`Sachsen` → Niedersachsen, `Gera` → Groß-Gerau, `Berlin` at gemeinde →
   Berlingen), and `jq '.[0]'` took it. Fields: keep only the
   named value fields (an unknown name is refused against the catalogue's field
   dictionary). A blank `region`, or a `fields` list without a non-blank name, is
   refused before any request instead of returning every row or every column.
5. **Defence in depth** (`sql.ts`). Right before interpolation, `buildSql` re-asserts
   the table matches `^[a-z0-9_]+$` and is not the boundary table, the typ is one of `{1,2,3,5}`, and the year is a
   4-digit integer — so a future refactor cannot route unvalidated text into SQL.

The tests prove: a bogus/injection-shaped indicator is rejected and **never reaches the
data transport**; an out-of-range or non-integer year is rejected; an unknown level is
rejected; and the built SQL contains only the allowlisted table plus the integer
typ/year (no `;`, `--`, or quotes).

## Library input validation

The library owns every rule about what a request may contain; the CLI only turns argv
into typed values and maps errors to exit codes. The rules are pure functions in
[`validate.ts`](src/client/validate.ts): a `Problem` returns the reason a value is
invalid, or `undefined`, and `assertValid(name, value, problem)` turns a reason into a
`RegionalatlasValidationError` with the message `Invalid <name>: <reason>`. Client
methods check their input before any request (an async method rejects rather than
throwing synchronously), so a rejected input sends nothing. The CLI's commander parsers
call the same functions and report the reason as a usage error, and `run.ts` maps a
`RegionalatlasValidationError` raised in an action, or while the client is built, to
exit 2 (an `ERROR` record of `regionalatlas.cli`). `test/helpers.ts` has a `parity()` helper that drives one
input through `run()` and through the library on one recording mock transport.

What the library refuses with `RegionalatlasValidationError`, before any request:

- **Blank filters** (`nonEmptyProblem`): `indicators({ theme, search })` and
  `query`/`queryResult({ region })` with `""` or a whitespace-only value, and `fields`
  without a non-blank name (`fieldsProblem`; blank entries next to real names are
  dropped). A blank filter would otherwise be skipped and return the unfiltered set.
  `filterIndicators` and `filterByRegion` apply the same rule. The CLI's `--theme`,
  `--search`, `--region` and `--fields` parsers call the same functions.
- **The `indicators` year filter** (`yearProblem`, `normaliseYearFilter`): an integer
  1000..9999 or an unpadded 4-digit string (`YEAR_SHAPE`, the catalogue's year-key
  shape). `" 2020"`, `""`, `1.5`, `20` or `"02020"` would otherwise match nothing (a
  false empty list) or, for `""`, be skipped. `--year` uses the same rule for both
  commands.
- **Header values** (`headerValueProblem`, `assertHeaderValue` in engine.ts), checked
  when the client is built: `userAgent` and every `defaultHeaders` value must be
  non-blank, without C0 controls (tab allowed) or DEL, and within Latin-1; a
  `defaultHeaders` name must be an RFC 9110 token (`headerNameProblem`). Only an
  omitted `userAgent` selects the default. The CLI's `--user-agent` parser uses the same
  rule. As a last net, the default transport turns a header Node refuses into a
  `RegionalatlasNetworkError` (`Invalid request: …`) instead of a raw `TypeError`.
- **URLs** (`httpUrlProblem`, `baseUrlProblem`, `validateHttpUrl` in engine.ts), checked
  when the client is built: `baseUrl` and `catalogUrl` must be non-blank `http:`/`https:`
  URLs without surrounding or interior whitespace or control characters; `baseUrl` also
  without a query or fragment. Userinfo is allowed (sent as Basic auth, redacted in
  messages), but a `%` in it must start a valid escape (`%25` for a literal one): Node
  decodes it for the Basic-auth header and would fail only at request time. The CLI also redacts on output: `run.ts` (`redactionFor`, `withRedactedOutput`) takes the
  exact userinfo of every URL argument (`credentialsIn`, exported) and replaces it with `***`
  in everything it prints — commander's usage errors, which echo a rejected
  `--base-url`/`--catalog-url`, and its own messages — so a password with spaces,
  quotes, `#`, `?` or `/` is caught as well as an ordinary one. Only a value that starts
  with a scheme counts (a bare `a:b@c` is a search text, a region name or a User-Agent as
  often as a credential), except as the value of `--base-url` or `--catalog-url` or in
  `REGIONALATLAS_BASE_URL`, where a `user:password@host` typed without its scheme is still
  read as a credential. The forms a server echoes
  a userinfo back in are replaced too (`echoedCredentialForms`, `redactSecrets`): the
  `Basic` value and the decoded `user:password` on stdout and stderr, the password alone
  (4 characters or more) on stderr only, since it may well occur in the data. `redactUrl` falls back to
  the same text-based cut for a value that doesn't parse as a URL. The library keeps
  them out of logged objects too: the engine holds the base URL and the client the
  catalogue URL in real `#private` fields, so `console.log(client)`, `util.inspect` and
  `JSON.stringify` don't show them, and the engine scrubs the userinfo of both (raw and
  percent-decoded, and the forms a server echoes it back in: the `Basic` value, the
  decoded `user:password`, the password alone from 4 characters) from error bodies, details, transport error text and the `cause`
  chain (`redact`, `scrubCause`). The catalogue's "Failed to parse JSON response from …"
  and "returned an empty body" messages name it redacted. Whatever a custom transport
  throws reaches the caller as a `RegionalatlasNetworkError` (the original as `cause`).
  A bad value used to be accepted and fail later, after the catalogue request,
  as a `RegionalatlasNetworkError`. The engine keeps its per-request scheme check
  (`assertHttpScheme`) as defence in depth for absolute URLs. `--base-url` and
  `--catalog-url` use the same rules.
- **Plain `http:`** (`cleartextProblem(url, secrets?, urlName?)` in engine.ts, exported):
  one sentence when requests to `url` would travel unencrypted — `requests to <host> are
  sent unencrypted (http:, not https:)`, or naming what travels with them (`the base
  URL's credentials`, `the catalogue URL's token`) — and `undefined` for `https:`, an
  unparseable URL and loopback hosts. `<host>` is `url.host`, never the userinfo. The
  CLI's `action()` wrapper logs the sentence as a `WARN` record of `regionalatlas.http` before the client is
  built, once per URL the command contacts: the catalogue URL always, the base URL only
  for `query` (`themes`/`indicators` never reach the data host). Help, version and usage
  errors never warn; stdout and the exit code are unchanged. The library never warns.
- **`?token=` in the catalogue URL** is a credential: in ArcGIS a `token` query
  parameter is the access token `generateToken` issues for a secured service, and OAuth 2
  sends `access_token` the same way (RFC 6750) — `SECRET_QUERY_PARAMETERS`. The public
  `services.json` takes none; a mirror behind a token login may. `redactUrl` shows the
  value as `token=***` (alongside the `***@` userinfo), the engine adds the value (raw,
  decoded, and cleaned as `sanitizeServerText` leaves an echo of it, the detail being
  redacted again after cleaning) to what `redact`/`scrubCause` scrub from bodies, details,
  transport text and causes, and `withRedactedOutput` redacts it from CLI output (`queryTokensIn`,
  `redactQueryTokens`; a bare value under six characters only in its `token=` form). It
  never crosses origins: only the catalogue request carries it, the base URL takes no
  query, and no redirect is followed.
- **`REGIONALATLAS_BASE_URL`** (`program.ts`): the CLI reads it through the injectable
  `CliDeps.env` (`process.env` in `defaultDeps`) as the default of `--base-url` — flag >
  variable > built-in default, an empty variable counts as unset. Commander doesn't run
  value parsers on defaults, so a `preAction` hook checks it with `parseBaseUrl` before
  any command runs and fails as a usage error naming the variable, never its value, with
  no help after it; the `help` command skips the check (P19). `redactionFor` adds
  the variable's userinfo to its secrets, and `--help` shows the default redacted. The
  library has no environment lookup: a library caller passes `baseUrl`.

## ArcGIS specifics

- **Logical errors are HTTP 200 with `{"error":{code,message,details}}`** (verified
  live — a malformed query returns HTTP 200, not a 4xx). The client **sniffs for a
  top-level `error` key in the 2xx body** and throws `RegionalatlasApiError`
  (`arcgisCode` set) — it does not rely on the HTTP status alone. Any truthy `error`
  counts (a proxy's bare `"Token Required"` or `true` too); `describeArcGisError` joins
  message and details without repeats, for the 200 envelope and non-2xx replies alike.
  A body that is not a JSON object, or has no `features` array, is a
  `RegionalatlasParseError` (`Unexpected response shape from <path>: expected …`), not
  an empty result. The `error.message`
  is run through `sanitizeServerText` before it can reach stderr: control and bidi
  characters dropped, whitespace folded to one line; the joined message and details are
  then cut at 500 characters (`cutForMessage`), as for an HTTP error's detail, while
  `body` keeps the whole answer. The catalogue is a second trust
  domain (`--catalog-url`), so its texts (titles, units, theme names) go through the
  same function when parsed — they appear in error messages such as the list of
  `Available:` columns. As a last net, run.ts strips C0 (except tab/newline), DEL and
  C1 from everything written to stderr, which covers arguments quoted back as typed.
- **Charset:** a JSON body (data and catalogue) is decoded by the charset its
  Content-Type names, UTF-8 when it names none (`decodeBody`, `TextDecoder`): a Latin-1
  reply from a mirror reads correctly, a BOM is dropped, and an unknown charset label is a
  `RegionalatlasParseError`. Both live hosts send UTF-8.
- **Error messages shorten the URL**: `shortenUrl` replaces every query-parameter value
  longer than 60 characters with `…` (in practice the `layer` parameter, ~750 characters
  of encoded SQL), so the reason is not buried at the end of an 800-character line.
  `RegionalatlasApiError.url` keeps the full URL.
- **`exceededTransferLimit`**: the MapServer stops at its `maxRecordCount` (2,000,000 on
  2026-09-26, so no real query reaches it today) and says so only in this flag.
  `queryResult()` passes it on (`=== true` only), and the CLI prints an `INFO` note on
  stderr with the rows it got; `query()` returns the rows alone.
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
- `region.test.ts` — `--region` matching (`matchRegion`): an exact name over substring hits,
  ambiguous names, the zero-padded official keys of filled-in rows, and the CLI's notes.
- `cli.test.ts` — the three commands, `--level`/`--year` parse-time validation, the
  guard exit codes, and the hardening guards (control-char UA, empty/non-http URL,
  bounded retries, option-shaped filter values).
- `engine.test.ts` — URL building for both hosts, the retry ladder incl. `Retry-After`,
  the scheme guard, and JSON decoding/error mapping.
- `output-errors.test.ts` — `handleOutputErrors`: EPIPE and ENOTCONN (a socket stdout
  whose reader has gone) on stdout exit 0, on stderr they are ignored.
- `log.test.ts` — the record helpers of `src/cli/log.ts` on their own
  (`escapeForRecord`, `formatLogRecord`); the CLI-level checks are P23's.
- `validate.test.ts` — the input rules, `assertValid`, and how `run()` reports a
  `RegionalatlasValidationError`.
- `parity.test.ts` — the same input through the CLI and the library (`parity()`): both
  reject without a request, or both send the identical requests.
- `conformance-p*.test.ts` — the workspace's shared conformance checks from the
  2026-10-05 review (P1 credential redaction in CLI output, P2 in library objects, P4
  base-URL validation, P5 transport contract, P6 retry policy, P7 pipes and exit codes,
  P8/P9/P13 charset, body shape and error classes, P20 the stderr warning for a plain-`http:`
  URL, P21 README links only to files the npm package ships — others by their GitHub URL,
  P23 the stderr log: records with timestamp, level and topic, `--log-format text|jsonl`);
  copied across the `*-cli` repos, only
  the adapter block at the top differs. `catalog-url-redaction.test.ts` repeats P1, P2
  and P4 for the second URL, `--catalog-url`.

## Conventions to keep

- **Zero runtime HTTP deps**; strict TS + ESM; passes on Node 22/24 (`engines` `>=22.12`, commander 15's floor; CI runs 22 and 24).
- **Exit codes** (`run.ts`): help/version → 0; usage/validation → 2; 404 → 4;
  network → 6; other → 1. The bin shim installs `handleOutputErrors()` (io.ts) before
  `run()`: an EPIPE on stdout (a reader that stops early, `| head`) exits 0 quietly, an
  EPIPE on stderr is ignored so the run's own code stands, and any other stdout error
  prints one `Output error:` line and exits 1. **Redirects are NOT followed** (a 3xx surfaces as an error;
  from the data host that means a base-URL misconfiguration → usage).
- **Retry/backoff:** `429`/`503` and reset connections are retried up to `maxRetries`
  (default 2); a refused connection, a DNS failure and a timeout are not. Each retry waits
  the linear backoff (`retryDelayMs × attempt`, 200 ms, 400 ms, …) at least — a
  `Retry-After: 0` or a date in the past never makes a zero-delay burst. A 429/503 retry honours
  a longer `Retry-After` header in either documented form — delta-seconds (digits only) or an
  HTTP-date in IMF-fixdate form (`Sat, 26 Sep 2026 10:00:00 GMT`) — clamped to 30 s so a
  server-set `Retry-After: 86400` cannot park the CLI for a day. A missing or malformed
  header (`1.5`, `-5`, any other date format) falls back to linear backoff
  (`retryDelayMs × attempt`); `parseRetryAfter` never hands it to a bare `Date.parse`,
  which reads `"1.5"` as a date in 2001 and so retried at once. When the retries run out,
  the final error says so: `HTTP 503 for GET … (retried 2 times)` (a
  `RegionalatlasApiError` with `retries: 2`), or `socket hang up (retried 2 times)` for a
  reset connection (`retriedSuffix`, exported). An error that was never retried has no
  suffix and `retries: 0`.
- **Custom transports:** the engine enforces `timeoutMs` itself for every transport — the
  request carries an `AbortSignal` (`HttpRequest.signal`) that fires at the deadline, and
  the call rejects then with a `RegionalatlasNetworkError` whether the transport stops or
  not — and checks the size of the body it gets back against `maxResponseBytes`
  (`sizeLimitMessage` names both the option and `--max-response-bytes`). The error is a
  `RegionalatlasSizeLimitError` (a `RegionalatlasNetworkError`) whose `download` says
  which one was too big, `"catalogue"` or `"data"`, so the CLI's hint fits: raise the cap
  for the catalogue, a coarser `--level` or a higher cap for a data reply. A transport may
  return the body as a Buffer, any `ArrayBuffer` view (fetch's `Uint8Array`, from any
  realm) or an `ArrayBuffer`, and the headers as a plain record in any case, a `Headers`
  object or a `Map` (`plainHeaders`; `Retry-After` is read either way). Whatever it throws
  becomes a `RegionalatlasNetworkError`, and a malformed response (no status, NaN) too; a
  reset reported as Node's `ECONNRESET`/`EPIPE`/`ECONNABORTED` or undici's
  `UND_ERR_SOCKET` anywhere in the `cause` chain is retried like a 503 (linear backoff).
- **Unknown option keys are refused** (`assertKnownKeys`): `query`/`queryResult` take
  `indicator`, `level`, `year`, `region`, `fields` (`QUERY_OPTION_KEYS`), `indicators`
  takes `theme`, `year`, `search` (`INDICATOR_FILTER_KEYS`). Any other own key —
  `serach`, `levle`, `__proto__` from JSON — is a `RegionalatlasValidationError` with a
  "did you mean", before any request; it used to be ignored, so the call answered with the
  whole catalogue or the default level. These filters work on the client, so nothing
  would be sent for an unknown key and there is no `allowUnknownFilters` opt-out. The CLI
  makes a single-value option given twice a usage error (`forbidRepeatedOptions`);
  `--fields` collects.
- **Wrong-typed input is a validation error, before any request:** `query(null)`,
  `{ indicator: 2020 }`, `{ year: "2020" }`, `indicators(null)`, a non-function
  `transport`/`sleep`, a non-object `defaultHeaders` or options object all throw
  `RegionalatlasValidationError` (`assertIndicatorInput`, `assertYearInput`,
  `assertIndicatorFilter`), never a raw `TypeError`; `null` options count as none. Echoed
  values and server text in messages are cut at 500 characters (`cutForMessage`,
  `MAX_MESSAGE_VALUE_LENGTH`, exported), never inside a surrogate pair (`cutText`), so the
  message stays well-formed; a string option value is quoted. A message that lists
  catalogue columns, unknown `--fields` names or catalogue years shows at most
  `MAX_LISTED_ITEMS` (40, exported) and counts the rest (`… (N more)`), each column code
  and title cut at 60 characters; the CLI's region notes cut each region they name, the
  `--region`, `--theme` and `--search` they quote at 500.
- **Engine options are checked** (`intOption` in engine.ts): `timeoutMs` 0..2^31−1,
  `maxRetries` 0..`MAX_RETRIES` (10, shared with `--max-retries`), `retryDelayMs`
  0..30 000, `maxResponseBytes` 0..`Number.MAX_SAFE_INTEGER`; anything else (negative,
  fractional, NaN, Infinity) throws `RegionalatlasValidationError`
  (`Invalid option <name>: expected an integer from 0 to <max>, got <v>.`) instead of
  silently disabling the timeout or the size cap.
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

## The log on stderr

Every diagnostic line on stderr is a log record (`src/cli/log.ts`): a timestamp, a level
(`ERROR`, `WARN`, `INFO`) and a topic, `regionalatlas.<area>`. `--log-format text` (the
default) writes it log4j style, `<ISO 8601 UTC> <LEVEL padded to 5> [<topic>] <message>`;
`--log-format jsonl` writes one JSON object per line with exactly `ts`, `level`, `topic`
and `msg`. A record is always one line: `formatLogRecord` runs `escapeForRecord` over
the message (text) or the whole JSON object (jsonl), which writes CR and LF as `\r`/`\n`,
every other C0 control but TAB, DEL and C1 as `\u00XX`, and U+2028, U+2029 and the bidi
controls as `\uXXXX`, so no text that reaches a record, by whatever path, can split it,
forge another one or steer the terminal. Before that a lone surrogate (half a
character, which jq rejects, stopping the whole stream) becomes U+FFFD (`toWellFormed`),
and a message longer than `MAX_RECORD_MESSAGE` (4000 characters, exported) is cut at a
code point and ends in `… (N more characters)`. The areas are `cli` (usage errors, commander's messages, validation errors, an
unexpected response shape, unexpected errors), `api` (the hosts' error answers, and the
notes on an empty, cut-off or ambiguous result) and `http` (the connection: network errors
and their size-cap hints, the cleartext warning). Code logs through `logOf(deps)` and never
writes diagnostics with `io.err` directly. `run()` builds the logger from argv before
commander parses it (`logFormatFromArgv`, used only for the records of a parse error: it
takes the first `--log-format`, the one `forbidRepeatedOptions` keeps, and skips the value
of the program's own value options, as commander does; a `preAction` hook then sets the
format commander parsed, so `--user-agent --log-format=jsonl` logs text), so commander's
own usage errors are records too: its `error: …` an
ERROR of `cli` (a `(Did you mean …?)` line joined to it), the help it shows after one an
INFO record per line, and a run with options but no command (`regionalatlas --compact`)
an ERROR "missing command: `regionalatlas <subcommand>`" before that help, so every
failed run has an ERROR record (`writeCommanderErr`). The log is built with the run's
redaction (`redactionFor`, `withRedactedOutput`), which replaces a secret in the message
only, before it is escaped: the frame is never touched (a catalogue token equal to the
topic or a year can't corrupt it), and a secret is kept out of the log in either format. `CliDeps.now` makes the timestamps testable. stdout carries data only. Two
lines stay raw: `Output error: …` from `handleOutputErrors` and the bin shim's last-resort
`Unexpected error: …`, both written outside `run()`. Conformance test P23 checks all of
this, and its body is shared across the *-cli repos.
