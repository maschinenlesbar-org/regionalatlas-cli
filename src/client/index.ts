// Public entry point for the API client library.

export {
  RegionalatlasClient,
  DEFAULT_CATALOG_URL,
  parseRow,
  filterByRegion,
  projectFields,
  specialValueReason,
  SPECIAL_VALUES,
  SPECIAL_VALUE_THRESHOLD,
} from "./client.js";
export type { RegionalatlasClientOptions } from "./client.js";
export { RequestEngine, DEFAULT_BASE_URL, sanitizeServerText, isBidiControl } from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
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
  findField,
  fieldKey,
  assertKnownFields,
  assertLevelPublished,
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
