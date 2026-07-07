// RegionalatlasClient — a typed client over the Regionalatlas Deutschland of the
// Statistische Ämter des Bundes und der Länder.
//
// TWO upstream hosts (see DEVELOPING.md):
//   (A) data   — the ArcGIS MapServer `dynamicLayer/query` on `baseUrl`
//                (default https://www.gis-idmz.nrw.de), which runs a raw SQL join.
//   (B) catalogue — the static `services.json` on statistikportal.de, listing the
//                21 themes / 70 indicators (`catalogUrl`).
//
// The ArcGIS server answers HTTP 200 even for logical errors, carrying them in an
// `error` object — the client checks for it and throws.
//
//   const c = new RegionalatlasClient();
//   await c.themes();                                    // the 21 subject areas
//   await c.indicators({ search: "bevölkerung" });       // matching indicators
//   await c.query({ indicator: "AI002-1-5", level: "land", year: 2020 }); // 16 rows

import { RequestEngine, sanitizeServerText, type EngineOptions } from "./engine.js";
import { RegionalatlasApiError, RegionalatlasParseError } from "./errors.js";
import {
  filterIndicators,
  parseIndicators,
  parseThemes,
  resolveIndicator,
  resolveYear,
  type IndicatorFilter,
} from "./catalog.js";
import { resolveLevel } from "./levels.js";
import { buildLayerParam } from "./sql.js";
import type {
  ArcGisQueryResponse,
  Indicator,
  QueryOptions,
  RawFeatureAttributes,
  RegionRow,
  Theme,
} from "./types.js";

/** The default catalogue URL (statistikportal.de services.json). */
export const DEFAULT_CATALOG_URL =
  "https://regionalatlas.statistikportal.de/taskrunner/services.json";

/** The ArcGIS MapServer path for the dynamicLayer data query (on `baseUrl`). */
const DATA_PATH =
  "/arcgis/rest/services/stba/regionalatlas/MapServer/dynamicLayer/query";

/** Options for the client (engine options plus the catalogue URL — no auth). */
export interface RegionalatlasClientOptions extends EngineOptions {
  /** Full URL of the indicator catalogue (services.json). Defaults to statistikportal.de. */
  catalogUrl?: string;
}

/**
 * The catalogue is fetched once per query/list call and cached for the lifetime of
 * the client instance, so a `query` (which needs the catalogue to resolve the
 * indicator) does not double-fetch.
 */
export class RegionalatlasClient {
  private readonly engine: RequestEngine;
  private readonly catalogUrl: string;
  private indicatorsCache: Indicator[] | undefined;
  private rawCatalogCache: unknown;

  constructor(options: RegionalatlasClientOptions = {}) {
    this.engine = new RequestEngine(options);
    this.catalogUrl = options.catalogUrl ?? DEFAULT_CATALOG_URL;
  }

  /** Fetch and cache the raw services.json (an array of themes). */
  private async rawCatalog(): Promise<unknown> {
    if (this.rawCatalogCache === undefined) {
      const raw = await this.engine.getJsonAbsolute<unknown>(this.catalogUrl);
      if (raw === null || raw === undefined) {
        throw new RegionalatlasParseError(
          `The catalogue at ${this.catalogUrl} returned an empty body.`,
        );
      }
      this.rawCatalogCache = raw;
    }
    return this.rawCatalogCache;
  }

  /** Fetch and cache the flat indicator list. */
  private async allIndicators(): Promise<Indicator[]> {
    if (this.indicatorsCache === undefined) {
      this.indicatorsCache = parseIndicators(await this.rawCatalog());
    }
    return this.indicatorsCache;
  }

  /** The 21 subject areas (Themenbereiche), each with its indicator count. */
  async themes(): Promise<Theme[]> {
    return parseThemes(await this.rawCatalog());
  }

  /** The flat indicator list, optionally filtered by theme / year / search. */
  async indicators(filter: IndicatorFilter = {}): Promise<Indicator[]> {
    return filterIndicators(await this.allIndicators(), filter);
  }

  /**
   * Run a data query. Resolves the indicator against the catalogue allowlist, maps
   * the level to a `typ`, validates/defaults the year, then builds the SQL from
   * ONLY those validated pieces. `region` and `fields` are applied client-side and
   * never enter the request.
   */
  async query(opts: QueryOptions): Promise<RegionRow[]> {
    // 1. Resolve the indicator against the catalogue allowlist (throws if unknown).
    const indicators = await this.allIndicators();
    const indicator = resolveIndicator(indicators, opts.indicator);
    // 2. Map level → typ (throws if unknown).
    const level = resolveLevel(opts.level);
    // 3. Validate/default the year (throws if not an integer in the indicator's years).
    const year = resolveYear(indicator, opts.year);

    // 4. Build the SQL from validated pieces only.
    const layer = buildLayerParam(indicator.table, level.typ, year);

    const res = await this.getData({
      layer: JSON.stringify(layer),
      f: "json",
      outFields: "*",
      returnGeometry: false,
      where: "1=1",
      spatialRel: "esriSpatialRelIntersects",
    });

    const rows = (res.features ?? []).map((f) =>
      parseRow(f.attributes, level.typ, level.name, year),
    );

    // 5. Client-side region filter + field projection (no user text upstream).
    const filtered = opts.region ? filterByRegion(rows, opts.region) : rows;
    return opts.fields && opts.fields.length > 0 ? projectFields(filtered, opts.fields) : filtered;
  }

  /** GET the dynamicLayer data query, then throw on the ArcGIS `error` envelope. */
  private async getData(params: Record<string, string | number | boolean>): Promise<ArcGisQueryResponse> {
    const res = await this.engine.getJson<ArcGisQueryResponse>(DATA_PATH, params);
    // The endpoint answers with a JSON envelope object. A null (empty/204 body) or
    // non-object reply means the endpoint did not return the expected shape.
    if (res === null || typeof res !== "object") {
      throw new RegionalatlasParseError(
        `Expected a JSON object from the data query but received ${res === null ? "an empty body" : typeof res}.`,
      );
    }
    // Logical errors arrive as HTTP 200 with a top-level `error` key — sniff for it.
    const err = res.error;
    if (err && typeof err === "object") {
      // The ArcGIS `error` message/details come from the (attacker-controllable)
      // response body and flow into an Error.message printed raw to stderr; strip
      // control characters so a hostile endpoint cannot inject terminal escapes.
      const detail = [err.message, ...(Array.isArray(err.details) ? err.details : [])]
        .filter((s): s is string => typeof s === "string" && s.length > 0)
        .map(sanitizeServerText)
        .join("; ");
      throw new RegionalatlasApiError({
        url: this.engine.buildUrl(DATA_PATH, params),
        method: "GET",
        body: JSON.stringify(res),
        arcgisCode: typeof err.code === "number" ? err.code : undefined,
        detail: detail || undefined,
      });
    }
    return res;
  }
}

// --------------------------------------------------------------------------
// Row parsing & client-side filtering (exported for tests)
// --------------------------------------------------------------------------

/** The non-value join columns present on every feature (excluded from `values`). */
const JOIN_FIELDS = new Set([
  "id",
  "typ",
  "ags",
  "jahr",
  "gen",
  "jahr2",
  "ags2",
  "gen2",
]);

/**
 * Parse one raw ArcGIS feature into a `RegionRow`. Trims the leading-space padding
 * of `gen2`, prefers `gen` for the name, and keeps only the indicator value fields
 * (dropping the join columns and the `<field>v` precision-flag variants).
 */
export function parseRow(
  attrs: RawFeatureAttributes,
  typ: 1 | 2 | 3 | 5,
  level: string,
  year: number,
): RegionRow {
  const ags = String(attrs.ags ?? "").trim();
  const rawName = typeof attrs.gen === "string" ? attrs.gen : attrs.gen2;
  const name = typeof rawName === "string" ? rawName.trim() : "";

  // Null-prototype map: the keys are attacker-controllable ArcGIS field names, so a
  // `__proto__`/`constructor` field in a hostile/MITM'd body must land as a plain data
  // key, never reparenting the object or touching Object.prototype (defence-in-depth).
  const values: Record<string, number | null> = Object.create(null);
  for (const [key, value] of Object.entries(attrs)) {
    if (JOIN_FIELDS.has(key)) continue;
    // Drop the precision-flag variants: `<field>v` when `<field>` is also present.
    if (key.endsWith("v")) {
      const base = key.slice(0, -1);
      if (Object.prototype.hasOwnProperty.call(attrs, base)) continue;
    }
    values[key] = typeof value === "number" ? value : value === null ? null : Number(value);
    if (Number.isNaN(values[key] as number)) values[key] = null;
  }

  return { ags, name, typ, level, year, values };
}

/**
 * Client-side region filter. A numeric input is matched as an exact `ags` (ignoring
 * leading zeros on both sides); otherwise a case-insensitive substring of the name.
 */
export function filterByRegion(rows: RegionRow[], region: string): RegionRow[] {
  const trimmed = region.trim();
  if (trimmed === "") return rows;
  if (/^\d+$/.test(trimmed)) {
    const target = String(Number(trimmed)); // strip leading zeros
    return rows.filter((r) => String(Number(r.ags.replace(/\D/g, "") || "0")) === target);
  }
  const needle = trimmed.toLowerCase();
  return rows.filter((r) => r.name.toLowerCase().includes(needle));
}

/**
 * Client-side field projection: keep only the named value fields. Unknown field
 * names are ignored (never sent upstream). Names are matched case-insensitively.
 */
export function projectFields(rows: RegionRow[], fields: string[]): RegionRow[] {
  const wanted = new Set(fields.map((f) => f.trim().toLowerCase()).filter((f) => f !== ""));
  if (wanted.size === 0) return rows;
  return rows.map((r) => {
    // Null-prototype map, same rationale as parseRow: keys are response-derived.
    const values: Record<string, number | null> = Object.create(null);
    for (const [key, value] of Object.entries(r.values)) {
      if (wanted.has(key.toLowerCase())) values[key] = value;
    }
    return { ...r, values };
  });
}
