# regionalatlas-cli

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
- **`indicators`** lists the indicators — `code`, short title, year range — with
  `--theme` / `--year` / `--search` filters.
- **`query <code>`** fetches the data rows for an indicator at a geo level (`--level`,
  default `land`), for a year (`--year`, default the indicator's latest). `--region`
  and `--fields` filter and project **client-side**.

Global flags: `--base-url`, `--catalog-url`, `--timeout`, `--user-agent`,
`--max-retries`, `--max-response-bytes`, `--compact`. See [Usage.md](Usage.md).

## Library

```ts
import { RegionalatlasClient } from "@maschinenlesbar.org/regionalatlas-cli";

const c = new RegionalatlasClient();
await c.themes();                                                 // the subject areas
await c.indicators({ search: "bevölkerung" });                    // matching indicators
const rows = await c.query({ indicator: "AI002-1-5", level: "land", year: 2020 });
```

## Two hosts

Unlike most siblings, this CLI talks to **two** upstreams (documented in
[DEVELOPING.md](DEVELOPING.md)):

1. the **indicator catalogue** (`services.json` on statistikportal.de), and
2. the **ArcGIS MapServer** data query on gis-idmz.nrw.de, whose `dynamicLayer`
   runs a raw SQL join.

Because the data query embeds raw SQL, the indicator, geo level, and year are all
**validated against the catalogue allowlist before any SQL is built** — a bogus
indicator never reaches the server. See the injection-guard section in
[DEVELOPING.md](DEVELOPING.md).

## Documentation

- [Usage.md](Usage.md) — commands, options, the geo levels, exit codes
- [DEVELOPING.md](DEVELOPING.md) — architecture, the two-host split, the SQL guard
- [GLOSSARY.md](GLOSSARY.md) — AGS, typ / geo levels, Indikator, table code, precision flags
- [DATA_LICENSE.md](DATA_LICENSE.md) — the dl-de/by-2.0 data terms
- [SKILLS.md](SKILLS.md) — the Claude Code skills this repo ships

## Licence

Code is dual-licensed **AGPL-3.0-or-later OR commercial** — see
[LICENSING.md](LICENSING.md). No external code contributions are accepted (see
[CONTRIBUTING.md](CONTRIBUTING.md)); bug reports and AGPL forks are welcome.
