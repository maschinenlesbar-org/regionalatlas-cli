# regionalatlas-cli

[![CI](https://github.com/maschinenlesbar-org/regionalatlas-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/regionalatlas-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/regionalatlas-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/regionalatlas-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/regionalatlas-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/regionalatlas-cli)

**Website:** [English](https://maschinenlesbar.org/regionalatlas-cli/) · [Deutsch](https://maschinenlesbar.org/regionalatlas-cli/de/) — command reference, guides and API docs

A dependency-light **TypeScript client + CLI** for the **Regionalatlas Deutschland** —
the regional-statistics indicators of the **Statistische Ämter des Bundes und der
Länder** (Destatis and the 16 Länder offices), broken down per **Bundesland /
Regierungsbezirk / Kreis / Gemeinde**. Backed by a public **ArcGIS MapServer** plus a
static indicator catalogue.

- **No API key.** The regional-statistics data is open.
- **Zero runtime HTTP dependencies.** Built on `node:http`/`https`; the CLI's only
  runtime dependency is `commander`.
- **Library + CLI.** Use the typed `RegionalatlasClient`, or the `regionalatlas` command.

> **We provide the tool, not the data.** The data is © the **Statistische Ämter des
> Bundes und der Länder** under **Datenlizenz Deutschland – Namensnennung 2.0**
> (dl-de/by-2.0) — free to use with attribution. See [DATA_LICENSE.md](DATA_LICENSE.md).

## Install

```bash
npm install -g @maschinenlesbar.org/regionalatlas-cli   # the `regionalatlas` command
# or as a library:
npm install @maschinenlesbar.org/regionalatlas-cli
```

Requires **Node.js 22.12+**.

### Docker

From 0.11.0 every release is also a container image for linux/amd64 and linux/arm64 on the
GitHub Container Registry, made from the same tarball as the npm package. It needs no Node.js and no
install:

```bash
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
  ghcr.io/maschinenlesbar-org/regionalatlas-cli:latest query AI002-1-5 --level land
```

The image's entrypoint is the program, so the command follows the image name directly;
`… regionalatlas-cli:latest regionalatlas themes` works too.

In a container with a memory limit (`--memory`) the default `--max-response-bytes` is an eighth
of that limit (at most the usual 100 MiB), so an oversized answer is refused with a clear
error instead of the container being killed for memory. The catalogue is about 2 MB, and a query
at `--level gemeinde` several MB; give such a container 128 MB or more.
The CLI needs at least 12 processes and threads (`--pids-limit 12`): below that it refuses with
an error, and with 4 or fewer Node.js itself hangs before the CLI can check.

`latest` is the newest release. For scripts, name a release and pin its digest, which the
[release notes](https://github.com/maschinenlesbar-org/regionalatlas-cli/releases) give:
`…/regionalatlas-cli:0.11.0@sha256:<digest>`. Each image carries signed build provenance;
check it with

```bash
gh attestation verify oci://ghcr.io/maschinenlesbar-org/regionalatlas-cli:latest \
  --repo maschinenlesbar-org/regionalatlas-cli
```

### MCP server

From 0.11.0 the Regionalatlas is also an [MCP](https://modelcontextprotocol.io/) server for AI
agents, `@maschinenlesbar.org/regionalatlas-mcp` (command `regionalatlas-mcp`, image
`ghcr.io/maschinenlesbar-org/regionalatlas-mcp`): four read-only tools, to find an indicator in
the catalogue (by topic, code, theme, year or level, the value columns included), get it for every
region of a level, compare named regions on one value column against the whole level (or find its
highest and lowest), and list the themes, on stdio or Streamable HTTP. The tools handle the skills'
traps: a title is no code, the newest year may not be loaded yet, a region name can stand for
several regions. Setup for Claude Code, Claude Desktop and VS Code:
[MCP.md](https://github.com/maschinenlesbar-org/regionalatlas-cli/blob/main/MCP.md).

```bash
npm i -g @maschinenlesbar.org/regionalatlas-mcp
claude mcp add regionalatlas -- regionalatlas-mcp
```

Every result names its source and the attribution the Datenlizenz Deutschland asks for.

## CLI

```bash
regionalatlas themes                                             # the 21 subject areas
regionalatlas indicators --search bevölkerung                    # matching indicators
regionalatlas indicators --theme Bevölkerung --year 2024         # filter by theme + year
regionalatlas query AI002-1-5 --level land --year 2020           # 16 Bundesländer rows
regionalatlas query AI002-1-5 --level kreis                      # ~400 Kreise (latest year)
regionalatlas query AI002-1-5 --level land --region Bayern       # one region
regionalatlas query AI002-1-5 --level land --fields ai0201       # project value fields
```

- **`themes`** lists the subject areas (Themenbereiche) and their indicator counts.
- **`indicators`** lists the indicators — `code`, short and long title, every year offered and the levels per year — with
  `--theme` / `--year` / `--search` filters.
- **`query <code>`** fetches the data rows for an indicator at a geo level (`--level`,
  default `land`), for a year (`--year`, default the newest catalogue year, which may not
  be loaded yet: an empty result says so on stderr). `--region`
  and `--fields` filter and project **client-side**; `--region` takes an AGS or an exact
  name (else every name containing the text) and says on stderr when several regions
  match.

Global flags: `--base-url` (or the `REGIONALATLAS_BASE_URL` environment variable; the flag
wins), `--catalog-url`, `--timeout`, `--user-agent`, `--max-retries`,
`--max-response-bytes`, `--log-format`, `--compact`. See [Usage.md](https://github.com/maschinenlesbar-org/regionalatlas-cli/blob/main/Usage.md). A plain `http:` URL to a
remote host (base or catalogue URL) gets one warning on stderr per URL (`WARN
[regionalatlas.http] … sent unencrypted to <host> (http:, not https:)`); stdout and the
exit code are unchanged.

Data goes to stdout as JSON; each line on stderr is a **log record**: a timestamp (UTC), a
level (`ERROR`, `WARN`, `INFO`) and a topic, the program and the area it comes from
(`regionalatlas.cli` for usage errors, `regionalatlas.api` for the hosts' answers, an
ArcGIS `error` envelope and a malformed answer included, a `WARN` when characters of an
answer were not valid text and were replaced with U+FFFD, and the notes on an empty or
ambiguous result, `regionalatlas.http` for the connection,
`regionalatlas.output` when stdout itself can't be written or an answer is nested too deeply or too large to print). By
default it is written log4j style; `--log-format jsonl` writes one JSON object per line
instead. A record is always one line: a line break, a control character or a bidi control
in a message (a server's text, a value you typed) is written as an escape (`\n`,
`\u001b`, `\u202e`), so it can neither split a record nor forge another one, nor steer the
terminal; a message longer than 4000 characters is cut and ends in `… (N more characters)`:

```text
2026-10-09T14:03:12.481Z WARN  [regionalatlas.http] requests to mirror.example are sent unencrypted (http:, not https:)
2026-10-09T14:03:12.700Z WARN  [regionalatlas.http] HTTP 503 from mirror.example: retry 1 of 2 in 200 ms
2026-10-09T14:03:12.902Z INFO  [regionalatlas.api] the data host returned no rows for AI002-1-5 at level kreis in 2024. …
```

```bash
regionalatlas --log-format jsonl query AI002-1-5 2>log.jsonl   # {"ts":"…","level":"INFO","topic":"regionalatlas.api","msg":"…"}
```

## Library

```ts
import { RegionalatlasClient } from "@maschinenlesbar.org/regionalatlas-cli";

const c = new RegionalatlasClient();
await c.themes();                                                 // the subject areas
await c.indicators({ search: "bevölkerung" });                    // matching indicators
const rows = await c.query({ indicator: "AI002-1-5", level: "land", year: 2020 });
// queryResult() adds `fetched` (the rows the host returned before the region filter) and
// `region` (how it matched: by "ags", whole "name", "substring"; `others` it left out)
const { rows: hits, fetched, region } = await c.queryResult({ indicator: "AI002-1-5", level: "land", region: "Sachsen" });
// hits: Sachsen alone; region.others: Niedersachsen, Sachsen-Anhalt
```

## Two hosts

Unlike most siblings, this CLI talks to **two** upstreams (documented in
[DEVELOPING.md](https://github.com/maschinenlesbar-org/regionalatlas-cli/blob/main/DEVELOPING.md)):

1. the **indicator catalogue** (`services.json` on statistikportal.de), and
2. the **ArcGIS MapServer** data query on gis-idmz.nrw.de, whose `dynamicLayer`
   runs a raw SQL join.

Because the data query embeds raw SQL, the indicator, geo level, and year are all
**validated against the catalogue allowlist before any SQL is built** — a bogus
indicator never reaches the server. See the injection-guard section in
[DEVELOPING.md](https://github.com/maschinenlesbar-org/regionalatlas-cli/blob/main/DEVELOPING.md).

## Documentation

- [Usage.md](https://github.com/maschinenlesbar-org/regionalatlas-cli/blob/main/Usage.md) — commands, options, the geo levels, exit codes
- [DEVELOPING.md](https://github.com/maschinenlesbar-org/regionalatlas-cli/blob/main/DEVELOPING.md) — architecture, the two-host split, the SQL guard
- [GLOSSARY.md](https://github.com/maschinenlesbar-org/regionalatlas-cli/blob/main/GLOSSARY.md) — AGS, typ / geo levels, Indikator, table code, Veränderungsrate
- [DATA_LICENSE.md](DATA_LICENSE.md) — the dl-de/by-2.0 data terms
- [SKILLS.md](https://github.com/maschinenlesbar-org/regionalatlas-cli/blob/main/SKILLS.md) — the Claude Code skills this repo ships
- [MCP.md](https://github.com/maschinenlesbar-org/regionalatlas-cli/blob/main/MCP.md) — the same use cases as the tools of the MCP server, for any MCP client

## Licence

Code is dual-licensed **AGPL-3.0-or-later OR commercial** — see
[LICENSING.md](LICENSING.md). No external code contributions are accepted (see
[CONTRIBUTING.md](CONTRIBUTING.md)); bug reports and AGPL forks are welcome.
