// Canned Regionalatlas responses for the unit suite, shaped like the live upstream:
// the statistikportal.de catalogue (services.json) and the ArcGIS dynamicLayer data
// query. Trimmed to a handful of themes/indicators/rows.

/** The catalogue: an array of themes, each with indicator children. */
export const catalog = [
  {
    title: "Gebiet und Fläche",
    children: [
      {
        code: "AI001-2-5",
        title_short: "Flächennutzung nach ALKIS",
        title_long: "Themenbereich Gebiet und Fläche — Flächennutzung",
        years: { "2016": [], "2020": [], "2022": [] },
      },
    ],
  },
  {
    title: "Bevölkerung",
    children: [
      {
        code: "AI002-1-5",
        title_short: "Bevölkerungsstand - Geburten - Gestorbene - Wanderungen",
        title_long: "Themenbereich Bevölkerung — Bevölkerungsstand",
        years: { "2000": [], "2020": [], "2024": [] },
      },
      {
        code: "AI002-2-5",
        title_short: "Bevölkerung nach Altersgruppen",
        title_long: "Themenbereich Bevölkerung — Altersgruppen",
        years: { "2019": [], "2020": [] },
      },
    ],
  },
];

/** A data-query response for AI002-1-5 at the land level, 2020 (two of the 16 rows). */
export const landData = {
  objectIdFieldName: "id",
  geometryType: "esriGeometryPolygon",
  fields: [
    { name: "id", type: "esriFieldTypeOID", alias: "id" },
    { name: "typ", type: "esriFieldTypeSmallInteger", alias: "typ" },
    { name: "ags", type: "esriFieldTypeString", alias: "ags" },
    { name: "jahr", type: "esriFieldTypeInteger", alias: "jahr" },
    { name: "gen", type: "esriFieldTypeString", alias: "gen" },
    { name: "ai0201", type: "esriFieldTypeDouble", alias: "ai0201" },
  ],
  features: [
    {
      attributes: {
        id: 454257,
        typ: 1,
        ags: "03",
        jahr: 2020,
        gen: "Niedersachsen",
        jahr2: 2020,
        ags2: "03",
        gen2: "  Niedersachsen",
        ai0201: 167.8,
        ai0202: 12.3,
        ai0201v: 0.1,
      },
    },
    {
      attributes: {
        id: 454258,
        typ: 1,
        ags: "04",
        jahr: 2020,
        gen: "Bremen",
        jahr2: 2020,
        ags2: "04",
        gen2: "  Bremen",
        ai0201: 1620.8,
        ai0202: -15.7,
        ai0201v: -0.2,
      },
    },
  ],
};

/** An ArcGIS logical error returned with HTTP 200 (the key correctness case). */
export const arcgisError = {
  error: { code: 400, extendedCode: -2147024809, message: "Invalid or missing input parameters.", details: [] },
};
