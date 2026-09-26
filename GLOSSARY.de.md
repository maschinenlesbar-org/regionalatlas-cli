# Glossar

Begriffe und Felder des Regionalatlas, so wie die CLI sie ausgibt.

| Begriff | In der CLI | Bedeutung |
|---|---|---|
| **Regionalatlas Deutschland** | – | Die Sammlung regionalstatistischer Karten und Indikatoren der Statistischen Ämter des Bundes und der Länder. |
| **Regionaldatenbank Deutschland** | Datenquelle | Die zugrunde liegende regionalstatistische Datenbank (GENESIS, `regionalstatistik.de`), aus der die Indikatoren stammen. |
| **Themenbereich** | `themes` | Ein Sachgebiet, z. B. `Bevölkerung`, `Wahlen`, `Umwelt`. Es gibt **21**. |
| **Indikator** | `indicators`, `query <code>` | Eine einzelne messbare Größe, identifiziert durch einen **Code** (z. B. `AI002-1-5`). Es gibt **70**. |
| **code** | `AI002-1-5` | Die Katalogkennung eines Indikators (unabhängig von Groß-/Kleinschreibung, mit Bindestrich oder Unterstrich). |
| **Tabellencode** | `ai002_1_5` | Der aus dem Code abgeleitete SQL-Tabellenname: `code.toLowerCase().replace(/-/g,"_")`. Wird auch von `query` akzeptiert. |
| **typ / Gebietsebene** | `--level` | Die räumliche Aggregationsebene. `land`=1 (Bundesländer, 16), `regierungsbezirk`/`rb`=2 (38 Zeilen), `kreis`/`landkreis`=3 (400 Zeilen), `gemeinde`=5 (ca. 11 000 Zeilen). Jede Ebene deckt **ganz Deutschland** ab – siehe *Auffüllen der Ebene*. |
| **Auffüllen der Ebene** | Länge von `ags` | Wo eine feinere Einheit nicht existiert, füllt eine Ebene mit der nächstgröberen auf. Dadurch ist jede Ebene eine vollständige, überschneidungsfreie Abdeckung Deutschlands, und die Länge von `ags` variiert innerhalb einer Ebene. `regierungsbezirk` liefert 38 Zeilen: die **29** tatsächlichen Regierungsbezirke (3-stelliger AGS) plus die **9 Bundesländer ohne Regierungsbezirke** (2-stellig: Schleswig-Holstein, Hamburg, Bremen, Saarland, Berlin, Brandenburg, Mecklenburg-Vorpommern, Sachsen-Anhalt, Thüringen). `kreis` und `gemeinde` enthalten Berlin (`11`) und Hamburg (`02`) 2-stellig; `gemeinde` zusätzlich 104 kreisfreie Städte unter ihrem 5-stelligen Kreisschlüssel. „Die 38 Regierungsbezirke“ ist also falsch – Summieren oder Kartieren einer Ebene bleibt aber korrekt. |
| **AGS** (Amtlicher Gemeindeschlüssel) | `ags` | Der amtliche Schlüssel eines Landes, Kreises oder einer Gemeinde (ein String, z. B. `03` für Niedersachsen, `03361` für einen Kreis). Führende Nullen sind bedeutsam – `--region` ignoriert sie beim Abgleich numerischer Eingaben. |
| **Gebietsname** | `name` | Der Name der Region (in den Daten `gen`), z. B. `Niedersachsen`, `Bremen`. |
| **jahr / year** | `--year`, `year` | Das Berichtsjahr (eine vierstellige Ganzzahl). Jeder Indikator bietet bestimmte Jahre an, oft mit Lücken, die der Bereich „erstes–letztes Jahr“ aus `indicators` (z. B. `1998–2025` für `AI005`) nicht zeigt. Ohne `--year` wird das neueste Katalogjahr verwendet, das der Datenhost womöglich noch nicht geladen hat: `query` liefert dann `[]` und weist auf stderr darauf hin. |
| **Wertfeld** | `values` | Eine Wertspalte eines Indikators (z. B. `ai0201`) – eine Zahl oder `null`. `--fields` behält nur die genannten (unabhängig von Groß-/Kleinschreibung, `-` und `_` gleichwertig). `indicators` listet jede Spalte eines Indikators mit Bezeichnung und Einheit auf, unter dem Schlüssel, den sie in `values` trägt – der Katalog der Zensus-2011-Indikatoren schreibt `AI-Z01`, der Datenhost `ai_z01`, und die CLI verwendet für beides `ai_z01`. |
| **Veränderungsrate (`v`-Feld)** | `values` | Eine `<field>v`-Spalte (z. B. `ai0201v`) ist die **Veränderungsrate** des zugehörigen Wertfelds gegenüber dem Vorjahr – ein eigenständiger veröffentlichter Wert, kein Präzisionsflag. Einheit ist **Prozent**, bei Anteilsindikatoren **Prozentpunkte** (`ai0208v`); `indicators` nennt die Einheit je Spalte. |
| **gen2 / ags2 / jahr2** | (intern) | Die verknüpfte Seite des SQL-`LEFT OUTER JOIN`. `gen2` ist in den Rohdaten mit führenden Leerzeichen aufgefüllt – der Client entfernt sie; die geparste Zeile verwendet `gen`/`ags`/`jahr`. |
| **dynamicLayer / queryTable** | (intern) | Der ArcGIS-Mechanismus, der den rohen SQL-Join hinter `query` ausführt. |
| **`--base-url` / `--catalog-url`** | Optionen | Der ArcGIS-Datenhost bzw. die URL des Indikatorenkatalogs (die beiden Upstream-Hosts). |

## Die Daten lesen

- **`query` liefert eine Zeile je Region** auf der gewählten `--level`-Ebene: `{ ags, name, typ,
  level, year, values }`.
- **Ein `null`-Wert** bedeutet, dass der Indikator für diese Region bzw. dieses Jahr keinen Wert hat.
- **Geografie wird mit Statistik verknüpft** – jede Region der Ebene erscheint; auch eine Region
  ohne Indikatorzeile ist enthalten (ihre `values` sind `null`), dank des `LEFT OUTER JOIN`.
- **Der Indikatorenkatalog ist die Allowlist** – nur katalogisierte Codes/Tabellen lassen sich
  abfragen; mit `indicators` finden Sie sie.
