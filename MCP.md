# regionalatlas-mcp

An [MCP](https://modelcontextprotocol.io/) server for the
[Regionalatlas Deutschland](https://regionalatlas.statistikportal.de/) of the Statistische Ämter
des Bundes und der Länder, as tools for AI agents. Read-only, no key.

The Regionalatlas publishes about 70 regional indicators in 21 themes (population, elections,
labour market, income, health, transport, environment …) per Land, Regierungsbezirk, Kreis and
Gemeinde, by year. The data are open under the Datenlizenz Deutschland – Namensnennung 2.0
(attribution required, see Licence below).

It is the MCP side of [regionalatlas-cli](https://github.com/maschinenlesbar-org/regionalatlas-cli),
built on the same typed client, and released with it.

## Install

```bash
npm i -g @maschinenlesbar.org/regionalatlas-mcp
```

This installs the **`regionalatlas-mcp`** command (Node.js 22.12+). Or run the container
image, for linux/amd64 and linux/arm64, which needs no Node.js:

```bash
docker run -i --rm ghcr.io/maschinenlesbar-org/regionalatlas-mcp:latest
```

## Connect a client

The server speaks MCP on stdio by default.

**Claude Code**

```bash
claude mcp add regionalatlas -- regionalatlas-mcp
# or with the image:
claude mcp add regionalatlas -- docker run -i --rm ghcr.io/maschinenlesbar-org/regionalatlas-mcp:latest
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "regionalatlas": { "command": "regionalatlas-mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "regionalatlas": { "type": "stdio", "command": "regionalatlas-mcp" } } }
```

**Over HTTP** (Streamable HTTP, one endpoint `POST /mcp`):

```bash
regionalatlas-mcp --transport http            # http://127.0.0.1:3000/mcp
claude mcp add --transport http regionalatlas http://127.0.0.1:3000/mcp
```

In a container, publish the port on loopback only:
`docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/maschinenlesbar-org/regionalatlas-mcp:latest --transport http --host 0.0.0.0 --allowed-hosts localhost,127.0.0.1`.

For scripts and shared configs, pin a release and its digest from the
[release notes](https://github.com/maschinenlesbar-org/regionalatlas-cli/releases) instead of
`latest`: `…/regionalatlas-mcp:<version>@sha256:<digest>`. Check an image's provenance with
`gh attestation verify oci://ghcr.io/maschinenlesbar-org/regionalatlas-mcp:<version> --repo maschinenlesbar-org/regionalatlas-cli`.

## Tools

| Tool | What it answers |
|---|---|
| `findIndicators` | The indicators a topic, code, theme, year or level matches, each with its years, the levels it has figures at and its value columns (what each measures, its unit); a topic that is only a value column (Wahlbeteiligung) is found there; a code gives its indicator alone, with its levels per year. |
| `getIndicatorMap` | One indicator for every region of a level (Land, Regierungsbezirk, Kreis, Gemeinde) and year: key (AGS), name and values, with what each value column measures, how many regions have a figure, and the reasons where none is given; a page at a time. |
| `compareRegions` | One value column for a few named regions (by key or name), ranked against the whole level, with its mean and median; or the level's highest and lowest. |
| `listThemes` | The 21 subject areas, each with its indicators' codes and short titles. |

Every tool only reads. An answer is JSON (`structuredContent` and the same as text), with the
`source` it came from and the data licence. The skills' traps are handled in the tools: an
indicator is named by its code (a title is answered with the indicators it matches, never taken as
one); a level or year the indicator has no figures for is answered from the catalogue, with the
levels and years it has; the newest year the catalogue lists may not be loaded on the data host
yet, so a year left out falls back to the one before, and the answer says so; a level fills in
with coarser units (Berlin and Hamburg among the Kreise); a special value is no figure (null, with
the reason), but "nichts vorhanden" is exactly 0, except as a change rate in an indicator's first
year; a region name that several regions share or contain (Neustadt) is reported with its
candidates, and an exact name (München) names the regions that only contain it. A failure is a
tool error that says what to change.

The data come from two hosts: the indicator catalogue (`services.json` on
regionalatlas.statistikportal.de) and the ArcGIS data host (www.gis-idmz.nrw.de), which runs a
query built only from the catalogue's table name, the level's fixed type and a year the catalogue
lists; region names and value columns are matched in the answer, never sent. `--base-url` names a
mirror of both (its `/taskrunner/services.json` and `/arcgis/…` under one base); without it, each
host is its default. The server reads the catalogue again after six hours. The CLI's
`REGIONALATLAS_BASE_URL` is not read: the server takes its configuration from its arguments.

## Options

```
--transport <stdio|http>   stdio (default), or Streamable HTTP on POST /mcp
--host <address>           HTTP: the address to listen on (default 127.0.0.1)
--port <n>                 HTTP: the port (default 3000)
--allowed-hosts <list>     HTTP: Host header names to answer (default localhost,127.0.0.1,[::1])
--allowed-origins <list>   HTTP: browser origins allowed to call, exactly (https://app.example.org); none by default
--auth-token-file <path>   HTTP: a file with the bearer token every request must send (mode 600, 32+ characters)
--base-url <url>           a mirror of both hosts (default: each host, https://regionalatlas.statistikportal.de
                           for the catalogue and https://www.gis-idmz.nrw.de for the data)
--timeout <ms>             per upstream request (default 30000)
--call-timeout <ms>        per tool call, retries included (default 45000)
--max-result-chars <n>     cap on one tool result's JSON (default 25000)
--max-pages <n>            pages a tool reads per list and call (default 10)
--user-agent <ua>          User-Agent header value
--log-format <text|jsonl>  the log records on stderr (default text)
```

## What it does and doesn't do

- **Read-only.** No tool changes anything, here or upstream.
- **No authentication** on HTTP unless you give one. It listens on loopback by default; it checks
  the `Host` header and, from a browser, the `Origin` (only the origins given with
  `--allowed-origins`, matched exactly) against DNS rebinding and other web pages. With
  `--auth-token-file <path>` every request must send `Authorization: Bearer <token>` (the file holds
  one token of at least 32 characters, mode 600, owned by the user the server runs as; read once at
  start; `(umask 077; openssl rand -hex 32 > mcp-token)` makes one); anything else is answered 401.
  Exposed beyond localhost (it logs a warning then), it belongs behind a proxy that authenticates or
  at least terminates TLS.
- **Gentle with the upstream.** One server process sends at most 2 requests at a time and 120 a
  minute to the API, pauses on HTTP 429 (as long as its Retry-After asks, at most 30 s), and stops a
  tool call after its deadline (a tool that has read part of its answer by then may answer with that
  part, and says so). A request those limits would hold longer than it or its call may wait is not
  sent: the call fails at once, naming the limit and when to ask again (and the log says so).
- **Results are data.** Text from the API is cleaned (control, bidi and zero-width characters
  removed), but it is still other people's text: a model can be told things in it. The server
  can't act on that (it has no tool that writes), but other tools in the same session could.
- **Stops cleanly.** On `docker stop` (SIGTERM) or Ctrl-C the HTTP server takes no new
  connection and lets calls in flight answer for up to 5 s, then exits 143 (130); a second signal
  ends it at once. On stdio it ends at once, and when stdin ends.
- **In a container** it needs at least 12 processes and threads (`--pids-limit`) and about
  256 MB of memory.
- **Logs** go to stderr, one record per line; stdout carries only the protocol. A call that fails
  upstream or reaches its deadline leaves a WARN record naming the tool.
- **Never installs anything.**

## Licence

Code: AGPL-3.0-or-later or commercial
([LICENSING.md](https://github.com/maschinenlesbar-org/regionalatlas-cli/blob/main/LICENSING.md)).
Data: © Statistische Ämter des Bundes und der Länder, under the
[Datenlizenz Deutschland – Namensnennung 2.0](https://www.govdata.de/dl-de/by-2-0) (dl-de/by-2-0):
free to use, also commercially, with attribution. Name the source and the licence, for example
"Datenquelle: Regionalatlas Deutschland, © Statistische Ämter des Bundes und der Länder, 2025,
dl-de/by-2-0", with the date retrieved. Every result carries this in its `licence` field
([DATA_LICENSE.md](https://github.com/maschinenlesbar-org/regionalatlas-cli/blob/main/DATA_LICENSE.md)).
We provide the tool, not the data.
