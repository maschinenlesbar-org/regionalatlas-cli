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
| **typ / Gebietsebene** | `--level` | Die räumliche Aggregationsebene. `land`=1 (Bundesländer, 16), `regierungsbezirk`/`rb`=2, `kreis`/`landkreis`=3 (Kreise/kreisfreie Städte, ca. 400), `gemeinde`=5 (Gemeinden). |
| **AGS** (Amtlicher Gemeindeschlüssel) | `ags` | Der amtliche Schlüssel eines Landes, Kreises oder einer Gemeinde (ein String, z. B. `03` für Niedersachsen, `03361` für einen Kreis). Führende Nullen sind bedeutsam – `--region` ignoriert sie beim Abgleich numerischer Eingaben. |
| **Gebietsname** | `name` | Der Name der Region (in den Daten `gen`), z. B. `Niedersachsen`, `Bremen`. |
| **jahr / year** | `--year`, `year` | Das Berichtsjahr (eine vierstellige Ganzzahl). Jeder Indikator bietet bestimmte Jahre an; ohne `--year` wird das neueste verwendet. |
| **Wertfeld** | `values` | Eine Wertspalte eines Indikators (z. B. `ai0201`) – eine Zahl oder `null`. `--fields` behält nur die genannten. |
| **Präzisionsflag-Feld `v`** | (entfernt) | Eine `<field>v`-Variante (z. B. `ai0201v`) kennzeichnet Genauigkeit bzw. Qualität des zugehörigen Wertfelds. Die geparste `RegionRow` verwirft diese Felder, sodass `values` nur die Messwerte enthält. |
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
