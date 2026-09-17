# Examples

Real examples for the Claude Code skills of the `regionalatlas` plugin, one per skill: a request,
the `regionalatlas` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 15 September 2026 with `regionalatlas` 0.0.4.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [regionalatlas-catalog](#regionalatlas-catalog) · [regionalatlas-compare](#regionalatlas-compare) · [regionalatlas-map](#regionalatlas-map)

## regionalatlas-catalog

> What regional data does the Regionalatlas have on childcare, and how recent is it?

```bash
regionalatlas themes --compact | jq -r '.[] | "\(.title)\t\(.indicatorCount)"'
regionalatlas indicators --search kita --compact   # [] + "Note: none of the 70 … match --search "kita"."
regionalatlas indicators --search betreu --compact | jq '.[] | {code, theme, titleShort, years}'
regionalatlas indicators --search betreu --year 2025 --compact | jq -r '.[].code'
regionalatlas indicators --search Betreuungsquote --compact | jq '.[].fields'   # what the columns mean
regionalatlas query AI003-3 --level land --year 2025 --region Schleswig --compact
```

"Kita" matched nothing, so the skill searched for the stem `betreu`. It found four indicators under three different themes, so searching by theme alone would have missed some.

The catalogue has 21 themes and 70 indicators. Four of them cover childcare, and all four include 2025:

| Code | Theme | Indicator | Years |
|---|---|---|---|
| `AI003-1` | Bildung | Betreute Kinder in Tagespflege/Tageseinrichtungen | 2007–2025 |
| `AI003-3` | Bildung | Betreuungsquote | 2011–2025 |
| `AIG-03-1` | Gender | Kinderbetreuung | 2007–2025 |
| `AI-N-05` | Nachhaltigkeit | Ganztagsbetreuung von Kindern | 2009–2025 |

For "what share of children are in care", use `AI003-3` (Betreuungsquote). `indicators` names its
two value columns, so no probing query is needed to read them:

| Column | Unit | Measures |
|---|---|---|
| `ai0306` | Prozent | Betreuungsquote 0 bis 2 Jahre am 01.03. |
| `ai0307` | Prozent | Betreuungsquote 3 bis 5 Jahre am 01.03. |

Schleswig-Holstein 2025 is `ai0306` 41.3 % of under-3s and `ai0307` 92.1 % of 3-to-5s.
Data © Statistische Ämter des Bundes und der Länder, dl-de/by-2.0.

Next steps offered: pull `AI003-3` for every Kreis (regionalatlas-map) or set a few Länder side by side (regionalatlas-compare).

## regionalatlas-compare

> How does disposable income per inhabitant compare between the cities of Munich and Leipzig, Görlitz and Gelsenkirchen? Where do they rank among all Kreise?

```bash
regionalatlas indicators --search kopf --compact                    # AI-S-01 Verfügbares Einkommen pro Kopf, 2000–2022
regionalatlas query AI-S-01 --level kreis --region München --compact  # 2 rows: Landkreis and Stadt
regionalatlas query AI-S-01 --level kreis --fields ai1601 --compact \
  | jq '[.[] | select(.name|test("München|Gelsenkirchen|Leipzig|Görlitz"))] | map({ags, name, v: .values.ai1601})'
```

Both "München" and "Leipzig" match a city and a Landkreis of the same name, so the name filter returned six rows. The skill kept the cities by AGS (`09162`, `14713`) and listed the two Landkreise separately. It fetched the whole level once, so ranking all Kreise needed no extra requests. Every row is 2022, and none is `null`.

Verfügbares Einkommen pro Kopf (`AI-S-01`, field `ai1601`), 2022, 400 Kreise:

| Region | AGS | Value | Rank of 400 |
|---|---|---:|---:|
| München (Stadt) | 09162 | 35,467 | 5 |
| Görlitz | 14626 | 22,671 | 360 |
| Leipzig (Stadt) | 14713 | 21,460 | 385 |
| Gelsenkirchen | 05513 | 18,522 | 400 |
| *for reference:* München, Landkreis | 09184 | 35,832 | 3 |
| *for reference:* Leipzig, Landkreis | 14729 | 25,523 | 199 |

Highest: Starnberg (09188) 40,205 · Miesbach (09182) 38,621. Lowest: Gelsenkirchen 18,522 ·
Duisburg (05112) 19,325 · Bremerhaven (04012) 20,059. The unweighted mean over the 400 Kreise is 25,631.
Munich has almost twice Gelsenkirchen's figure. The output gives no unit.
Data © Statistische Ämter des Bundes und der Länder, dl-de/by-2.0.

## regionalatlas-map

> Give me car density (Pkw-Dichte) for every Kreis, latest year. Which are highest and lowest?

```bash
regionalatlas indicators --search pkw --compact                     # AI013-1 Pkw-Dichte, 2000–2026 (also AI-N-08-01)
regionalatlas query AI013-1 --level kreis --fields ai1301 --compact # [] exit 0: latest catalogue year 2026 has no rows
regionalatlas query AI013-1 --level kreis --year 2025 --compact | jq '.[0]'
regionalatlas query AI013-1 --level kreis --year 2025 --fields ai1301 --compact \
  | jq -r '.[] | "\(.ags)\t\(.name)\t\(.values.ai1301)"'
```

Leaving out `--year` should give the latest year. The catalogue lists 2026 as latest, but there is no data for it yet, and the query returned an empty list with exit 0. The skill retried with 2025. That returned all 400 Kreise with no `null` values. Berlin comes back as a single Kreis row with AGS `11`.

Pkw-Dichte (`AI013-1`, field `ai1301`), 2025, 400 Kreise and kreisfreie Städte. Median 638.15, range 334.5–955.9:

| Highest | AGS | ai1301 | | Lowest | AGS | ai1301 |
|---|---|---:|---|---|---|---:|
| Wolfsburg | 03103 | 955.9 | | Berlin | 11 | 334.5 |
| Euskirchen | 05366 | 803.0 | | Leipzig | 14713 | 384.0 |
| Wiesbaden | 06414 | 775.5 | | Heidelberg | 08221 | 393.4 |
| Main-Taunus-Kreis | 06436 | 773.9 | | Freiburg im Breisgau | 08311 | 402.7 |
| Südwestpfalz | 07340 | 761.7 | | Dresden | 14612 | 406.5 |
| Hohenlohekreis | 08126 | 760.5 | | Jena | 16053 | 409.3 |

The 388 Kreise in between aren't shown; the full `ags / name / value` list is ready to join to Kreis boundaries for a choropleth.
Data © Statistische Ämter des Bundes und der Länder, dl-de/by-2.0.

Next steps offered: the same map for Länder (`--level land`) or an earlier year for a change map.
