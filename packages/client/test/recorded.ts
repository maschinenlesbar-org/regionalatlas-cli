// Answers of the Regionalatlas recorded live on 2026-11-20 (01:54 CET) and cut down, for the tests
// of the use cases (operations.ts) and the MCP server: the statistikportal.de catalogue
// (services.json) with five of its 21 themes, one indicator each, the years cut to a few and each
// year to its first entry (the levels with figures); and the ArcGIS data host's rows for AI005
// (Bundestagswahl) per Land in 2025, AI002-1-5 (Bevölkerung) for eleven of the 400 Kreise in 2024,
// and AI013-1 (Pkw-Dichte) per Land in 2025 and 2026 (no rows yet: the newest catalogue year not
// loaded). `regionalatlasApi` answers both on any host, so a test can point the client at a
// mirror (`baseUrl` and `catalogUrl` on one host) or leave the defaults.

import type { HttpRequest } from "../src/http.js";
import { jsonResponse, makeMockTransport, type MockTransport } from "./helpers.js";

/** The catalogue (services.json), cut down. */
export const RECORDED_CATALOG = [
  {
    "title": "Bevölkerung",
    "children": [
      {
        "code": "AI002-1-5",
        "title_short": "Bevölkerungsstand - Geburten - Gestorbene - Wanderungen",
        "title_long": "Regionalatlas Deutschland Themenbereich \"Bevölkerung\" Indikatoren zu \"Bevölkerungsstand - Geburten - Gestorbene - Wanderungen\" (Gemeindeebene ab 2008)",
        "years": {
          "2000": [{ "geom_levels": [16, 35, 462, 0] }],
          "2023": [{ "geom_levels": [16, 29, 397, 9280] }],
          "2024": [{ "geom_levels": [16, 29, 397, 9259] }]
        },
        "attributes": [
          { "code": "AI0201", "title_short": "Bevölkerungsdichte (EW je qkm)", "unit": "Anzahl" },
          { "code": "AI0202", "title_short": "Bevölkerungsentwicklung im Jahr je 10.000 EW", "unit": "Anzahl" },
          { "code": "AI0208", "title_short": "Anteil der ausländischen Bevölkerung an der Gesamtbevölkerung", "unit": "Prozent" },
          { "code": "AI0209", "title_short": "Lebendgeborene je 1.000 EW", "unit": "Anzahl" },
          { "code": "AI0210", "title_short": "Gestorbene je 1.000 EW", "unit": "Anzahl" },
          { "code": "AI0211", "title_short": "Geburten-/Gestorbenenüberschuss je 10.000 EW", "unit": "Anzahl" },
          { "code": "AI0212", "title_short": "Wanderungssaldo je 10.000 EW", "unit": "Anzahl" },
          { "code": "AI0201V", "title_short": "Bevölkerungsdichte (EW je qkm) (Veränderungsrate)", "unit": "Prozent" },
          { "code": "AI0208V", "title_short": "Anteil der ausländischen Bevölkerung an der Gesamtbevölkerung (Veränderungsrate in Prozentpunkten)", "unit": "PP" },
          { "code": "AI0209V", "title_short": "Lebendgeborene je 1.000 EW (Veränderungsrate)", "unit": "Prozent" },
          { "code": "AI0210V", "title_short": "Gestorbene je 1.000 EW (Veränderungsrate)", "unit": "Prozent" }
        ]
      }
    ]
  },
  {
    "title": "Wahlen",
    "children": [
      {
        "code": "AI005",
        "title_short": "Bundestagswahl",
        "title_long": "Regionalatlas Deutschland Themenbereich \"Wahlen\" Indikatoren zu \"Bundestagswahl\"",
        "years": {
          "1998": [{ "geom_levels": [16, 35, 452, 0] }],
          "2002": [{ "geom_levels": [16, 35, 452, 0] }],
          "2005": [{ "geom_levels": [16, 35, 462, 0] }],
          "2009": [{ "geom_levels": [16, 29, 409, 0] }],
          "2013": [{ "geom_levels": [16, 29, 399, 0] }],
          "2017": [{ "geom_levels": [16, 29, 398, 0] }],
          "2021": [{ "geom_levels": [16, 29, 397, 0] }],
          "2025": [{ "geom_levels": [16, 29, 397, 0] }]
        },
        "attributes": [
          { "code": "AI0501", "title_short": "Zweitstimmenanteil CDU/CSU, Bundestagswahl", "unit": "Prozent" },
          { "code": "AI0502", "title_short": "Zweitstimmenanteil SPD, Bundestagswahl", "unit": "Prozent" },
          { "code": "AI0503", "title_short": "Zweitstimmenanteil FDP, Bundestagswahl", "unit": "Prozent" },
          { "code": "AI0504", "title_short": "Zweitstimmenanteil GRÜNE, Bundestagswahl", "unit": "Prozent" },
          { "code": "AI0505", "title_short": "Zweitstimmenanteil DIE LINKE, Bundestagswahl", "unit": "Prozent" },
          { "code": "AI0507", "title_short": "Zweitstimmenanteil AfD, Bundestagswahl", "unit": "Prozent" },
          { "code": "AI0506", "title_short": "Wahlbeteiligung, Bundestagswahl", "unit": "Prozent" }
        ]
      }
    ]
  },
  {
    "title": "Verkehr",
    "children": [
      {
        "code": "AI013-1",
        "title_short": "Pkw-Dichte",
        "title_long": "Regionalatlas Deutschland Themenbereich \"Verkehr\" Indikatoren zu \"Pkw-Dichte\"",
        "years": {
          "2024": [{ "geom_levels": [16, 29, 396, 0] }],
          "2025": [{ "geom_levels": [16, 29, 396, 0] }],
          "2026": [{ "geom_levels": [16, 29, 396, 0] }]
        },
        "attributes": [
          { "code": "AI1301", "title_short": "Pkw-Bestand je 1.000 EW am 01.01.", "unit": "Anzahl" },
          { "code": "AI1301V", "title_short": "Pkw-Bestand je 1.000 EW am 01.01. (Veränderungsrate)", "unit": "Prozent" }
        ]
      }
    ]
  },
  {
    "title": "Gesundheitsökonomische Gesamtrechnungen",
    "children": [
      {
        "code": "AIGG-01",
        "title_short": "Gesundheitsausgaben",
        "title_long": "Regionalatlas Deutschland Themenbereich \"Gesundheitsökonomische Gesamtrechnungen\" Indikatoren zu \"Gesundheitsausgaben\"",
        "years": {
          "2023": [{ "geom_levels": [16, 0, 0, 0] }],
          "2024": [{ "geom_levels": [16, 0, 0, 0] }]
        },
        "attributes": [
          { "code": "GSAUS201", "title_short": "Gesundheitsausgaben je Einwohner/-in", "unit": "EUR" },
          { "code": "GSAAI22", "title_short": "Anteil der Ausgaben der Gesetzlichen Krankenversicherung (GKV) an den gesamten Gesundheitsausgaben", "unit": "Prozent" },
          { "code": "GSAAI26", "title_short": "Anteil der Ausgaben der Privaten Krankenversicherung (PKV) an den gesamten Gesundheitsausgaben", "unit": "Prozent" },
          { "code": "GSAAI23", "title_short": "Anteil der Ausgaben der Sozialen Pflegeversicherung (SPV) an den gesamten Gesundheitsausgaben", "unit": "Prozent" },
          { "code": "GSAAI28", "title_short": "Ant. d. Ausgaben der Priv. Haush. u. Organisationen o. Erwerbszweck a. d. ges. Gesundheitsausgaben", "unit": "Prozent" }
        ]
      }
    ]
  },
  {
    "title": "Zensus",
    "children": [
      {
        "code": "AI-Z1-2011",
        "title_short": "Bevölkerung - Durchschnittsalter - Migrationshintergrund",
        "title_long": "Regionalatlas Deutschland Themenbereich \"Zensus\" Indikatoren zu \"Bevölkerung - Durchschnittsalter - Migrationshintergrund\"",
        "years": {
          "2011": [{ "geom_levels": [16, 29, 409, 0] }]
        },
        "attributes": [
          { "code": "AI-Z01", "title_short": "Durchschnittsalter Gesamtbevölkerung", "unit": "Anzahl" },
          { "code": "AI-Z02", "title_short": "Durchschnittsalter weibliche Bevölkerung", "unit": "Anzahl" },
          { "code": "AI-Z03", "title_short": "Durchschnittsalter männliche Bevölkerung", "unit": "Anzahl" },
          { "code": "AI-Z04", "title_short": "Anteil Personen mit MHG an der Gesamtbevölkerung", "unit": "Prozent" },
          { "code": "AI-Z05", "title_short": "Anteil Personen mit MHG 0 bis 19 Jahre", "unit": "Prozent" },
          { "code": "AI-Z06", "title_short": "Anteil Personen mit MHG 20 bis 59 Jahre", "unit": "Prozent" },
          { "code": "AI-Z07", "title_short": "Anteil Personen mit MHG 60 Jahre und älter", "unit": "Prozent" }
        ]
      }
    ]
  }
];

type Attributes = Record<string, string | number | null>;

/** AI005 (Bundestagswahl) per Land, 2025: all 16 rows. ai0506 is the turnout, ai0507 the AfD share. */
export const ELECTION_LAND_2025: Attributes[] = [{"id": 535284, "typ": 1, "ags": "01", "jahr": 2025, "gen": "Schleswig-Holstein", "jahr2": 2025, "ags2": "01", "gen2": "  Schleswig-Holstein", "ai0501": 27.6, "ai0502": 18.8, "ai0503": 4.7, "ai0504": 14.9, "ai0505": 7.8, "ai0507": 16.3, "ai0506": 83.5}, {"id": 535285, "typ": 1, "ags": "02", "jahr": 2025, "gen": "Hamburg", "jahr2": 2025, "ags2": "02", "gen2": "  Hamburg", "ai0501": 20.7, "ai0502": 22.7, "ai0503": 4.5, "ai0504": 19.3, "ai0505": 14.5, "ai0507": 10.9, "ai0506": 80.9}, {"id": 535286, "typ": 1, "ags": "03", "jahr": 2025, "gen": "Niedersachsen", "jahr2": 2025, "ags2": "03", "gen2": "  Niedersachsen", "ai0501": 28.1, "ai0502": 23.0, "ai0503": 4.1, "ai0504": 11.5, "ai0505": 8.1, "ai0507": 17.8, "ai0506": 83.4}, {"id": 535287, "typ": 1, "ags": "04", "jahr": 2025, "gen": "Bremen", "jahr2": 2025, "ags2": "04", "gen2": "  Bremen", "ai0501": 20.6, "ai0502": 23.1, "ai0503": 3.5, "ai0504": 15.6, "ai0505": 14.8, "ai0507": 15.1, "ai0506": 77.8}, {"id": 535288, "typ": 1, "ags": "05", "jahr": 2025, "gen": "Nordrhein-Westfalen", "jahr2": 2025, "ags2": "05", "gen2": "  Nordrhein-Westfalen", "ai0501": 30.1, "ai0502": 20.0, "ai0503": 4.4, "ai0504": 12.4, "ai0505": 8.3, "ai0507": 16.8, "ai0506": 82.2}, {"id": 535289, "typ": 1, "ags": "06", "jahr": 2025, "gen": "Hessen", "jahr2": 2025, "ags2": "06", "gen2": "  Hessen", "ai0501": 28.9, "ai0502": 18.4, "ai0503": 5.0, "ai0504": 12.6, "ai0505": 8.7, "ai0507": 17.8, "ai0506": 83.1}, {"id": 535290, "typ": 1, "ags": "07", "jahr": 2025, "gen": "Rheinland-Pfalz", "jahr2": 2025, "ags2": "07", "gen2": "  Rheinland-Pfalz", "ai0501": 30.6, "ai0502": 18.6, "ai0503": 4.6, "ai0504": 10.3, "ai0505": 6.5, "ai0507": 20.1, "ai0506": 83.0}, {"id": 535291, "typ": 1, "ags": "08", "jahr": 2025, "gen": "Baden-Württemberg", "jahr2": 2025, "ags2": "08", "gen2": "  Baden-Württemberg", "ai0501": 31.6, "ai0502": 14.2, "ai0503": 5.6, "ai0504": 13.6, "ai0505": 6.8, "ai0507": 19.8, "ai0506": 83.4}, {"id": 535292, "typ": 1, "ags": "09", "jahr": 2025, "gen": "Bayern", "jahr2": 2025, "ags2": "09", "gen2": "  Bayern", "ai0501": 37.2, "ai0502": 11.5, "ai0503": 4.2, "ai0504": 12.0, "ai0505": 5.7, "ai0507": 19.0, "ai0506": 84.3}, {"id": 535293, "typ": 1, "ags": "10", "jahr": 2025, "gen": "Saarland", "jahr2": 2025, "ags2": "10", "gen2": "  Saarland", "ai0501": 26.9, "ai0502": 21.9, "ai0503": 4.3, "ai0504": 7.2, "ai0505": 7.4, "ai0507": 21.6, "ai0506": 82.4}, {"id": 535294, "typ": 1, "ags": "11", "jahr": 2025, "gen": "Berlin", "jahr2": 2025, "ags2": "11", "gen2": "  Berlin", "ai0501": 18.3, "ai0502": 15.1, "ai0503": 3.8, "ai0504": 16.8, "ai0505": 19.9, "ai0507": 15.2, "ai0506": 80.3}, {"id": 535295, "typ": 1, "ags": "12", "jahr": 2025, "gen": "Brandenburg", "jahr2": 2025, "ags2": "12", "gen2": "  Brandenburg", "ai0501": 18.1, "ai0502": 14.8, "ai0503": 3.2, "ai0504": 6.6, "ai0505": 10.7, "ai0507": 32.5, "ai0506": 81.6}, {"id": 535296, "typ": 1, "ags": "13", "jahr": 2025, "gen": "Mecklenburg-Vorpommern", "jahr2": 2025, "ags2": "13", "gen2": "  Mecklenburg-Vorpommern", "ai0501": 17.8, "ai0502": 12.4, "ai0503": 3.2, "ai0504": 5.4, "ai0505": 12.0, "ai0507": 35.0, "ai0506": 79.5}, {"id": 535297, "typ": 1, "ags": "14", "jahr": 2025, "gen": "Sachsen", "jahr2": 2025, "ags2": "14", "gen2": "  Sachsen", "ai0501": 19.7, "ai0502": 8.5, "ai0503": 3.2, "ai0504": 6.5, "ai0505": 11.3, "ai0507": 37.3, "ai0506": 81.1}, {"id": 535298, "typ": 1, "ags": "15", "jahr": 2025, "gen": "Sachsen-Anhalt", "jahr2": 2025, "ags2": "15", "gen2": "  Sachsen-Anhalt", "ai0501": 19.2, "ai0502": 11.0, "ai0503": 3.1, "ai0504": 4.4, "ai0505": 10.8, "ai0507": 37.1, "ai0506": 77.7}, {"id": 535299, "typ": 1, "ags": "16", "jahr": 2025, "gen": "Thüringen", "jahr2": 2025, "ags2": "16", "gen2": "  Thüringen", "ai0501": 18.6, "ai0502": 8.8, "ai0503": 2.8, "ai0504": 4.2, "ai0505": 15.2, "ai0507": 38.6, "ai0506": 80.7}];

/** AI002-1-5 (Bevölkerung) per Kreis, 2024: eleven of the 400 rows (München twice, Berlin and Hamburg at two digits, three Neustadt). */
export const POPULATION_KREIS_2024: Attributes[] = [{"id": 523354, "typ": 3, "ags": "03361", "jahr": 2024, "gen": "Verden", "jahr2": 2024, "ags2": "03361", "gen2": "      Verden, Landkreis", "ai0201": 175.6, "ai0202": 25.5, "ai0208": 9.6, "ai0209": 8.7, "ai0210": 12.4, "ai0211": -37.3, "ai0212": 65.3, "ai0201v": 0.3, "ai0208v": 0.3, "ai0209v": -4.9, "ai0210v": -2.4}, {"id": 523326, "typ": 3, "ags": "02", "jahr": 2024, "gen": "Hamburg", "jahr2": 2024, "ags2": "02", "gen2": "  Hamburg", "ai0201": 2466.7, "ai0202": 59.1, "ai0208": 19.3, "ai0209": 9.5, "ai0210": 10.0, "ai0211": -5.6, "ai0212": 67.1, "ai0201v": 0.6, "ai0208v": 0.4, "ai0209v": -4.7, "ai0210v": -5.3}, {"id": 523474, "typ": 3, "ags": "07316", "jahr": 2024, "gen": "Neustadt an der Weinstraße", "jahr2": 2024, "ags2": "07316", "gen2": "      Neustadt an der Weinstraße, kreisfreie Stadt", "ai0201": 452.2, "ai0202": 44.7, "ai0208": 13.4, "ai0209": 7.9, "ai0210": 14.5, "ai0211": -66.3, "ai0212": 109.2, "ai0201v": 0.4, "ai0208v": 0.6, "ai0209v": 1.0, "ai0210v": -0.3}, {"id": 523549, "typ": 3, "ags": "09184", "jahr": 2024, "gen": "München, Landkreis", "jahr2": 2024, "ags2": "09184", "gen2": "      München, Landkreis", "ai0201": 533.5, "ai0202": 46.0, "ai0208": 20.5, "ai0209": 7.7, "ai0210": 10.4, "ai0211": -26.8, "ai0212": 64.6, "ai0201v": 0.5, "ai0208v": 0.2, "ai0209v": -2.7, "ai0210v": 6.6}, {"id": 523534, "typ": 3, "ags": "09162", "jahr": 2024, "gen": "München", "jahr2": 2024, "ags2": "09162", "gen2": "      München, kreisfreie Stadt", "ai0201": 4843.9, "ai0202": 108.8, "ai0208": 28.5, "ai0209": 10.4, "ai0210": 8.4, "ai0211": 20.3, "ai0212": 81.2, "ai0201v": 1.1, "ai0208v": 0.5, "ai0209v": -1.1, "ai0210v": -1.9}, {"id": 523574, "typ": 3, "ags": "09374", "jahr": 2024, "gen": "Neustadt a.d.Waldnaab", "jahr2": 2024, "ags2": "09374", "gen2": "      Neustadt a.d.Waldnaab, Landkreis", "ai0201": 67.4, "ai0202": -16.6, "ai0208": 6.9, "ai0209": 9.8, "ai0210": 12.2, "ai0211": -24.2, "ai0212": 8.9, "ai0201v": -0.2, "ai0208v": 0.0, "ai0209v": 1.2, "ai0210v": 3.7}, {"id": 523672, "typ": 3, "ags": "14713", "jahr": 2024, "gen": "Leipzig", "jahr2": 2024, "ags2": "14713", "gen2": "      Leipzig, kreisfreie Stadt", "ai0201": 2054.6, "ai0202": 62.9, "ai0208": 13.8, "ai0209": 7.9, "ai0210": 11.1, "ai0211": -31.8, "ai0212": 96.8, "ai0201v": 0.6, "ai0208v": 0.3, "ai0209v": -5.1, "ai0210v": -2.7}, {"id": 523676, "typ": 3, "ags": "15002", "jahr": 2024, "gen": "Halle (Saale)", "jahr2": 2024, "ags2": "15002", "gen2": "      Halle (Saale), kreisfreie Stadt", "ai0201": 1672.8, "ai0202": -38.4, "ai0208": 13.4, "ai0209": 8.0, "ai0210": 14.1, "ai0211": -61.1, "ai0212": 26.3, "ai0201v": -0.4, "ai0208v": 0.4, "ai0209v": -4.6, "ai0210v": -2.4}, {"id": 523600, "typ": 3, "ags": "09575", "jahr": 2024, "gen": "Neustadt a.d.Aisch-Bad Windsheim", "jahr2": 2024, "ags2": "09575", "gen2": "      Neustadt a.d.Aisch-Bad Windsheim, Landkreis", "ai0201": 79.7, "ai0202": 6.0, "ai0208": 10.1, "ai0209": 8.2, "ai0210": 12.2, "ai0211": -39.9, "ai0212": 48.1, "ai0201v": 0.1, "ai0208v": 0.1, "ai0209v": -4.1, "ai0210v": -2.8}, {"id": 523635, "typ": 3, "ags": "11", "jahr": 2024, "gen": "Berlin", "jahr2": 2024, "ags2": "11", "gen2": "  Berlin", "ai0201": 4135.5, "ai0202": 62.3, "ai0208": 22.5, "ai0209": 9.2, "ai0210": 10.3, "ai0211": -10.7, "ai0212": 73.8, "ai0201v": 0.6, "ai0208v": 0.6, "ai0209v": -1.8, "ai0210v": -2.7}, {"id": 523689, "typ": 3, "ags": "16051", "jahr": 2024, "gen": "Erfurt", "jahr2": 2024, "ags2": "16051", "gen2": "      Erfurt, kreisfreie Stadt", "ai0201": 810.6, "ai0202": -34.5, "ai0208": 12.1, "ai0209": 6.7, "ai0210": 11.5, "ai0211": -48.9, "ai0212": 20.7, "ai0201v": -0.3, "ai0208v": 0.4, "ai0209v": -8.5, "ai0210v": -3.8}];

/** AI013-1 (Pkw-Dichte) per Land, 2025: all 16 rows. (2026, the newest catalogue year, had none yet.) */
export const CARS_LAND_2025: Attributes[] = [{"id": 535284, "typ": 1, "ags": "01", "jahr": 2025, "gen": "Schleswig-Holstein", "jahr2": 2025, "ags2": "01", "gen2": "  Schleswig-Holstein", "ai1301": 592.7, "ai1301v": 0.4}, {"id": 535285, "typ": 1, "ags": "02", "jahr": 2025, "gen": "Hamburg", "jahr2": 2025, "ags2": "02", "gen2": "  Hamburg", "ai1301": 435.2, "ai1301v": -0.9}, {"id": 535286, "typ": 1, "ags": "03", "jahr": 2025, "gen": "Niedersachsen", "jahr2": 2025, "ags2": "03", "gen2": "  Niedersachsen", "ai1301": 622.5, "ai1301v": 0.6}, {"id": 535287, "typ": 1, "ags": "04", "jahr": 2025, "gen": "Bremen", "jahr2": 2025, "ags2": "04", "gen2": "  Bremen", "ai1301": 427.0, "ai1301v": -0.2}, {"id": 535288, "typ": 1, "ags": "05", "jahr": 2025, "gen": "Nordrhein-Westfalen", "jahr2": 2025, "ags2": "05", "gen2": "  Nordrhein-Westfalen", "ai1301": 589.5, "ai1301v": 0.6}, {"id": 535289, "typ": 1, "ags": "06", "jahr": 2025, "gen": "Hessen", "jahr2": 2025, "ags2": "06", "gen2": "  Hessen", "ai1301": 622.1, "ai1301v": -0.1}, {"id": 535290, "typ": 1, "ags": "07", "jahr": 2025, "gen": "Rheinland-Pfalz", "jahr2": 2025, "ags2": "07", "gen2": "  Rheinland-Pfalz", "ai1301": 641.1, "ai1301v": 0.5}, {"id": 535291, "typ": 1, "ags": "08", "jahr": 2025, "gen": "Baden-Württemberg", "jahr2": 2025, "ags2": "08", "gen2": "  Baden-Württemberg", "ai1301": 619.8, "ai1301v": 0.5}, {"id": 535292, "typ": 1, "ags": "09", "jahr": 2025, "gen": "Bayern", "jahr2": 2025, "ags2": "09", "gen2": "  Bayern", "ai1301": 635.0, "ai1301v": 0.0}, {"id": 535293, "typ": 1, "ags": "10", "jahr": 2025, "gen": "Saarland", "jahr2": 2025, "ags2": "10", "gen2": "  Saarland", "ai1301": 645.8, "ai1301v": 0.5}, {"id": 535294, "typ": 1, "ags": "11", "jahr": 2025, "gen": "Berlin", "jahr2": 2025, "ags2": "11", "gen2": "  Berlin", "ai1301": 334.5, "ai1301v": -1.5}, {"id": 535295, "typ": 1, "ags": "12", "jahr": 2025, "gen": "Brandenburg", "jahr2": 2025, "ags2": "12", "gen2": "  Brandenburg", "ai1301": 583.6, "ai1301v": 0.7}, {"id": 535296, "typ": 1, "ags": "13", "jahr": 2025, "gen": "Mecklenburg-Vorpommern", "jahr2": 2025, "ags2": "13", "gen2": "  Mecklenburg-Vorpommern", "ai1301": 564.5, "ai1301v": 0.7}, {"id": 535297, "typ": 1, "ags": "14", "jahr": 2025, "gen": "Sachsen", "jahr2": 2025, "ags2": "14", "gen2": "  Sachsen", "ai1301": 541.9, "ai1301v": 0.5}, {"id": 535298, "typ": 1, "ags": "15", "jahr": 2025, "gen": "Sachsen-Anhalt", "jahr2": 2025, "ags2": "15", "gen2": "  Sachsen-Anhalt", "ai1301": 573.0, "ai1301v": 0.7}, {"id": 535299, "typ": 1, "ags": "16", "jahr": 2025, "gen": "Thüringen", "jahr2": 2025, "ags2": "16", "gen2": "  Thüringen", "ai1301": 567.8, "ai1301v": 0.8}];

/** The data host's rows per `table/typ/year` (typ 1 Land, 3 Kreis); anything else has none. */
export const RECORDED_ROWS: Record<string, Attributes[]> = {
  "ai005/1/2025": ELECTION_LAND_2025,
  "ai002_1_5/3/2024": POPULATION_KREIS_2024,
  "ai013_1/1/2025": CARS_LAND_2025,
};

/** The table, typ and year in a data query's SQL (the `layer` parameter), or undefined. */
export function sqlOf(request: HttpRequest): { table: string; typ: number; year: number; sql: string } | undefined {
  const layer = new URL(request.url).searchParams.get("layer");
  if (layer === null) return undefined;
  const sql = (JSON.parse(layer) as { source: { dataSource: { query: string } } }).source.dataSource.query;
  const match = /LEFT OUTER JOIN (\S+) ON .* WHERE typ = (\d+) AND jahr = (\d+) /.exec(sql);
  return match === null ? undefined : { table: match[1] as string, typ: Number(match[2]), year: Number(match[3]), sql };
}

export interface RecordedOverrides {
  /** The catalogue to answer instead of the recorded one. */
  catalog?: unknown;
  /** Rows per `table/typ/year`, over the recorded ones. */
  rows?: Record<string, Attributes[]>;
}

/**
 * A mock of both hosts: a path ending in /taskrunner/services.json is the catalogue, the
 * dynamicLayer query answers the rows of its SQL's table, typ and year (none when nothing is
 * recorded, as the data host answers a year it has not loaded), anything else a 404.
 */
export function regionalatlasApi(overrides: RecordedOverrides = {}): MockTransport {
  const rows = { ...RECORDED_ROWS, ...overrides.rows };
  return makeMockTransport((request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/taskrunner/services.json")) return jsonResponse(overrides.catalog ?? RECORDED_CATALOG);
    if (url.pathname.endsWith("/MapServer/dynamicLayer/query")) {
      const query = sqlOf(request);
      if (query === undefined) return jsonResponse({ error: { code: 400, message: "Invalid or missing input parameters.", details: [] } });
      const found = rows[`${query.table}/${query.typ}/${query.year}`] ?? [];
      return jsonResponse({ displayFieldName: "ags", features: found.map((attributes) => ({ attributes })) });
    }
    return jsonResponse({ error: "not found" }, 404);
  });
}
