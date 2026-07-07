# Data license

This document is about the **data** the Regionalatlas / Regionaldatenbank Deutschland
returns — which is **separate** from the license of this tool's **code** (see
[LICENSING.md](LICENSING.md)).

> **We provide the tool, not the data.** `regionalatlas-cli` is an independent client.
> It bundles no data. What you retrieve is governed by the terms of the data provider,
> the **Statistische Ämter des Bundes und der Länder**.

## Who provides the data

The **Regionalatlas Deutschland** visualises indicators from the **Regionaldatenbank
Deutschland / Regionalstatistik** — the regional-statistics collection of the
**Statistische Ämter des Bundes und der Länder** (the Federal Statistical Office,
Destatis, and the statistical offices of the 16 Länder). This CLI reads the same
indicators live via the public interfaces the Regionalatlas itself uses (the
statistikportal.de indicator catalogue and the ArcGIS MapServer that serves the map).

## The licence — Datenlizenz Deutschland – Namensnennung 2.0 (dl-de/by-2.0)

The Regionalstatistik / Regionaldatenbank Deutschland data of the statistical offices
is published as open data under the **Datenlizenz Deutschland – Namensnennung 2.0**
(**dl-de/by-2.0**). You may copy, distribute, make publicly available, adapt, and
combine the data — including commercially — **provided you give attribution
(Namensnennung)** to the source and reproduce the licence reference.

- Licence text (Deutsch): <https://www.govdata.de/dl-de/by-2-0>
- Licence text (English): <https://www.govdata.de/dl-de/by-2-0>

The statistical offices' own portals state the same requirement in plain words —
the statistikportal.de terms permit reproduction and distribution "mit Quellenangabe"
(with source attribution): "Die Vervielfältigung und Verbreitung, auch auszugsweise,
ist mit Quellenangabe gestattet."

### Required attribution (Namensnennung)

dl-de/by-2.0 requires you to name the source (the data holder), state the licence,
and — where the source provides one — reproduce a **Quellenvermerk**. A suitable
attribution is, for example:

> Datenquelle: Regionalatlas Deutschland / Regionaldatenbank Deutschland,
> © Statistische Ämter des Bundes und der Länder, `<Jahr>`, lizenziert unter
> [Datenlizenz Deutschland – Namensnennung 2.0](https://www.govdata.de/dl-de/by-2-0)
> — abgerufen am `<Datum>`.

Keep the attribution and licence reference when you republish or build products on
the data.

## Notes

- The individual indicators carry their own reference year(s) and reporting units;
  the underlying figures come from the statistical offices' regional statistics.
- The full source figures are also available as downloadable tables from the
  **Regionaldatenbank Deutschland** (GENESIS-Online, `regionalstatistik.de`); this
  tool reads the indicators the Regionalatlas publishes live.
- No personal data is published; the indicators are aggregate regional statistics.

## Not legal advice

This summary is a good-faith description, not legal advice, and the upstream terms can
change. The exact wording on the statistical offices' pages is authoritative; where a
page states a specific Quellenvermerk, use it verbatim. When in doubt, consult the
current terms at
[statistikportal.de](https://www.statistikportal.de/de/impressum) and
[regionalstatistik.de](https://www.regionalstatistik.de/). If you find the terms have
changed, please open an issue so this file can be updated.
