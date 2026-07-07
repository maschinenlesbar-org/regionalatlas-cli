// Public entry point for the API client library.

export {
  RegionalatlasClient,
  DEFAULT_CATALOG_URL,
  parseRow,
  filterByRegion,
  projectFields,
} from "./client.js";
export type { RegionalatlasClientOptions } from "./client.js";
export { RequestEngine, DEFAULT_BASE_URL, sanitizeServerText } from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryValue } from "./query.js";
export {
  parseThemes,
  parseIndicators,
  filterIndicators,
  resolveIndicator,
  resolveYear,
  tableForCode,
} from "./catalog.js";
export type { IndicatorFilter } from "./catalog.js";
export { GEO_LEVELS, LEVEL_ALIASES, findLevel, resolveLevel, levelForTyp } from "./levels.js";
export { buildSql, buildLayerParam } from "./sql.js";
export {
  RegionalatlasError,
  RegionalatlasApiError,
  RegionalatlasNetworkError,
  RegionalatlasValidationError,
  RegionalatlasParseError,
} from "./errors.js";

export * from "./types.js";
