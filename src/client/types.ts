// Types for the Regionalatlas Deutschland: the indicator catalogue (from the
// statistikportal.de services.json) and the ArcGIS dynamicLayer data query
// (from the gis-idmz.nrw.de MapServer).

// --------------------------------------------------------------------------
// Geo levels (Gebietstyp / `typ`)
// --------------------------------------------------------------------------

/**
 * The Regionalatlas geographic level, called `typ` in the data. Only these four
 * integers are ever interpolated into the SQL query — the CLI maps friendly names
 * onto them and rejects anything else. (`typ = 4` is not published.)
 */
export type GeoLevel = 1 | 2 | 3 | 5;

/** A friendly geo-level name and the `typ` it maps to. */
export interface GeoLevelInfo {
  /** Canonical friendly name (e.g. "land", "kreis"). */
  name: string;
  /** The `typ` integer used in the SQL. */
  typ: GeoLevel;
  /** A short human label (e.g. "Bundesländer"). */
  label: string;
}

// --------------------------------------------------------------------------
// Catalogue (services.json)
// --------------------------------------------------------------------------

/**
 * One indicator entry in the raw services.json catalogue. `years` is a map from a
 * 4-digit year string to per-year detail arrays; we only need its keys.
 */
export interface RawCatalogIndicator {
  code: string;
  title_short?: string;
  title_long?: string;
  timestamp?: string;
  years?: Record<string, unknown>;
  [key: string]: unknown;
}

/** One theme (subject area) in the raw services.json catalogue. */
export interface RawCatalogTheme {
  title: string;
  children?: RawCatalogIndicator[];
  [key: string]: unknown;
}

/** The parsed services.json is an array of themes. */
export type RawCatalog = RawCatalogTheme[];

/** A subject area (Themenbereich) with its indicator count. */
export interface Theme {
  /** Theme title, e.g. "Bevölkerung". */
  title: string;
  /** Number of indicators under this theme. */
  indicatorCount: number;
}

/**
 * A single indicator (Indikator), flattened out of the catalogue with a resolved
 * SQL `table` name and its available years. The `table` is derived solely from the
 * catalogue `code` and is the ONLY value ever interpolated as a table name into the
 * SQL query.
 */
export interface Indicator {
  /** Catalogue code, e.g. "AI002-1-5". */
  code: string;
  /** The SQL table name derived from the code (`code.toLowerCase().replace(/-/g,"_")`). */
  table: string;
  /** The theme (subject area) this indicator belongs to. */
  theme: string;
  /** Short title. */
  titleShort: string;
  /** Long, descriptive title. */
  titleLong: string;
  /** Available years, ascending, as 4-digit strings (e.g. ["2000","2005",…]). */
  years: string[];
}

// --------------------------------------------------------------------------
// Data query (ArcGIS dynamicLayer /query)
// --------------------------------------------------------------------------

/** ArcGIS field metadata (from the query response). */
export interface FieldInfo {
  name: string;
  type?: string;
  alias?: string;
  length?: number;
  [key: string]: unknown;
}

/** The raw attributes of one ArcGIS feature returned by the data query. */
export interface RawFeatureAttributes {
  id?: number;
  typ?: number;
  ags?: string;
  jahr?: number;
  gen?: string;
  jahr2?: number | null;
  ags2?: string | null;
  gen2?: string | null;
  /** The indicator value fields (e.g. `ai0201`) plus their `<field>v` flag variants. */
  [key: string]: unknown;
}

/** An ArcGIS feature (data query returns `returnGeometry=false`, so attributes only). */
export interface RawFeature {
  attributes: RawFeatureAttributes;
}

/**
 * The raw ArcGIS `/query` response envelope. On a logical failure the server still
 * answers HTTP 200 but sets `error` (checked by the client).
 */
export interface ArcGisQueryResponse {
  features?: RawFeature[];
  fields?: FieldInfo[];
  exceededTransferLimit?: boolean;
  objectIdFieldName?: string;
  geometryType?: string;
  error?: { code?: number; message?: string; details?: string[] };
  [key: string]: unknown;
}

/**
 * One parsed region row: the geographic unit plus its indicator values. The value
 * map keeps only the indicator value fields (the `<field>v` precision flags are
 * dropped from the parsed row — see the client), with numbers or `null`.
 */
export interface RegionRow {
  /** Amtlicher Gemeindeschlüssel (AGS). */
  ags: string;
  /** Gebietsname (region name), trimmed. */
  name: string;
  /** The `typ` integer (geo level). */
  typ: GeoLevel;
  /** The friendly geo-level name (e.g. "land"). */
  level: string;
  /** The reporting year. */
  year: number;
  /** Indicator value fields → number or null. */
  values: Record<string, number | null>;
}

/** Options for a data query. */
export interface QueryOptions {
  /** Indicator code (`AI002-1-5`) or table form (`ai002_1_5`); resolved against the catalogue. */
  indicator: string;
  /** Geo level: a friendly name (`land`, `kreis`, …) resolved to a `typ`. */
  level: string;
  /** Year; defaults to the indicator's latest available year. */
  year?: number;
  /** Client-side region filter: an AGS (numeric) or a substring of the name. */
  region?: string;
  /** Client-side field projection: keep only these value fields. */
  fields?: string[];
}
