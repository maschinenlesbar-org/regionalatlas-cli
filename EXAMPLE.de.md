# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `regionalatlas`, eines pro Skill: eine
Anfrage, die `regionalatlas`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 15. September 2026 mit `regionalatlas` 0.0.4 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [regionalatlas-catalog](#regionalatlas-catalog) · [regionalatlas-compare](#regionalatlas-compare) · [regionalatlas-map](#regionalatlas-map)

## regionalatlas-catalog

> Welche regionalen Daten zur Kinderbetreuung hat der Regionalatlas, und wie aktuell sind sie?

```bash
regionalatlas themes --compact | jq -r '.[] | "\(.title)\t\(.indicatorCount)"'
regionalatlas indicators --search kita --compact                    # [] – kein Indikator enthält „kita"
regionalatlas indicators --search betreu --compact | jq '.[] | {code, theme, titleShort, years}'
regionalatlas indicators --search betreu --year 2025 --compact | jq -r '.[].code'
regionalatlas query AI003-3 --level land --compact | jq '.[0]'      # Blick auf die Wertspalten
```

„Kita" ergab nichts, deshalb suchte der Skill mit dem Wortstamm `betreu`. Er fand vier Indikatoren in drei verschiedenen Themenbereichen. Eine Suche nur nach Thema hätte einige davon übersehen.

Der Katalog umfasst 21 Themenbereiche und 70 Indikatoren. Vier davon betreffen die Kinderbetreuung, und alle vier reichen bis 2025:

| Code | Themenbereich | Indikator | Jahre |
|---|---|---|---|
| `AI003-1` | Bildung | Betreute Kinder in Tagespflege/Tageseinrichtungen | 2007–2025 |
| `AI003-3` | Bildung | Betreuungsquote | 2011–2025 |
| `AIG-03-1` | Gender | Kinderbetreuung | 2007–2025 |
| `AI-N-05` | Nachhaltigkeit | Ganztagsbetreuung von Kindern | 2009–2025 |

Für „welcher Anteil der Kinder wird betreut" passt `AI003-3` (Betreuungsquote). Die Zeilen haben
zwei Wertspalten, `ai0306` und `ai0307` (Schleswig-Holstein 2025: 41,3 und 92,1). Was die
einzelnen Spalten messen, gibt die CLI nicht an. Daten © Statistische Ämter des Bundes und der
Länder, dl-de/by-2.0.

Als Nächstes angeboten: `AI003-3` für alle Kreise abrufen (regionalatlas-map) oder einige Länder nebeneinanderstellen (regionalatlas-compare).

## regionalatlas-compare

> Wie unterscheidet sich das verfügbare Einkommen pro Kopf zwischen den Städten München und Leipzig, Görlitz und Gelsenkirchen? Welchen Rang haben sie unter allen Kreisen?

```bash
regionalatlas indicators --search kopf --compact                    # AI-S-01 Verfügbares Einkommen pro Kopf, 2000–2022
regionalatlas query AI-S-01 --level kreis --region München --compact  # 2 Zeilen: Landkreis und Stadt
regionalatlas query AI-S-01 --level kreis --fields ai1601 --compact \
  | jq '[.[] | select(.name|test("München|Gelsenkirchen|Leipzig|Görlitz"))] | map({ags, name, v: .values.ai1601})'
```

Sowohl „München" als auch „Leipzig" treffen eine Stadt und den gleichnamigen Landkreis. Der Namensfilter lieferte deshalb sechs Zeilen. Der Skill hat die Städte über den AGS (`09162`, `14713`) ausgewählt und die beiden Landkreise getrennt aufgeführt. Er hat die ganze Ebene einmal abgerufen, für die Rangfolge über alle Kreise waren also keine weiteren Anfragen nötig. Alle Zeilen stammen aus 2022, keine ist `null`.

Verfügbares Einkommen pro Kopf (`AI-S-01`, Feld `ai1601`), 2022, 400 Kreise:

| Region | AGS | Wert | Rang von 400 |
|---|---|---:|---:|
| München (Stadt) | 09162 | 35.467 | 5 |
| Görlitz | 14626 | 22.671 | 360 |
| Leipzig (Stadt) | 14713 | 21.460 | 385 |
| Gelsenkirchen | 05513 | 18.522 | 400 |
| *zum Vergleich:* München, Landkreis | 09184 | 35.832 | 3 |
| *zum Vergleich:* Leipzig, Landkreis | 14729 | 25.523 | 199 |

Am höchsten: Starnberg (09188) 40.205 · Miesbach (09182) 38.621. Am niedrigsten: Gelsenkirchen
18.522 · Duisburg (05112) 19.325 · Bremerhaven (04012) 20.059. Der ungewichtete Mittelwert der 400 Kreise liegt bei 25.631.
München hat fast den doppelten Wert von Gelsenkirchen. Eine Einheit steht nicht in der Ausgabe.
Daten © Statistische Ämter des Bundes und der Länder, dl-de/by-2.0.

## regionalatlas-map

> Die Pkw-Dichte für alle Kreise, neuestes Jahr. Wo ist sie am höchsten und wo am niedrigsten?

```bash
regionalatlas indicators --search pkw --compact                     # AI013-1 Pkw-Dichte, 2000–2026 (auch AI-N-08-01)
regionalatlas query AI013-1 --level kreis --fields ai1301 --compact # [] Exit 0: neuestes Katalogjahr 2026 hat keine Zeilen
regionalatlas query AI013-1 --level kreis --year 2025 --compact | jq '.[0]'
regionalatlas query AI013-1 --level kreis --year 2025 --fields ai1301 --compact \
  | jq -r '.[] | "\(.ags)\t\(.name)\t\(.values.ai1301)"'
```

Ohne `--year` sollte das neueste Jahr kommen. Der Katalog nennt 2026 als neuestes Jahr, dafür gibt es aber noch keine Daten, und die Abfrage lieferte eine leere Liste mit Exit 0. Der Skill wiederholte sie mit 2025. Das ergab alle 400 Kreise ohne `null`-Werte. Berlin kommt als eine einzige Kreiszeile mit AGS `11`.

Pkw-Dichte (`AI013-1`, Feld `ai1301`), 2025, 400 Kreise und kreisfreie Städte. Median 638,15, Spanne 334,5–955,9:

| Am höchsten | AGS | ai1301 | | Am niedrigsten | AGS | ai1301 |
|---|---|---:|---|---|---|---:|
| Wolfsburg | 03103 | 955,9 | | Berlin | 11 | 334,5 |
| Euskirchen | 05366 | 803,0 | | Leipzig | 14713 | 384,0 |
| Wiesbaden | 06414 | 775,5 | | Heidelberg | 08221 | 393,4 |
| Main-Taunus-Kreis | 06436 | 773,9 | | Freiburg im Breisgau | 08311 | 402,7 |
| Südwestpfalz | 07340 | 761,7 | | Dresden | 14612 | 406,5 |
| Hohenlohekreis | 08126 | 760,5 | | Jena | 16053 | 409,3 |

Die 388 Kreise dazwischen sind nicht aufgeführt. Die vollständige Liste `ags / name / Wert` lässt sich für eine Choroplethenkarte mit den Kreisgrenzen verknüpfen.
Daten © Statistische Ämter des Bundes und der Länder, dl-de/by-2.0.

Als Nächstes angeboten: dieselbe Karte für die Länder (`--level land`) oder ein früheres Jahr, um Veränderungen zu zeigen.
