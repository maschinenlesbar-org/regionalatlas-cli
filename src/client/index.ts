// Public entry point for the API client library.

export {
  RegionalatlasClient,
  DEFAULT_CATALOG_URL,
  QUERY_OPTION_KEYS,
  parseRow,
  filterByRegion,
  matchRegion,
  projectFields,
  specialValueReason,
  SPECIAL_VALUES,
  SPECIAL_VALUE_THRESHOLD,
} from "./client.js";
export type { RegionalatlasClientOptions } from "./client.js";
export {
  RequestEngine,
  assertHeaderValue,
  validateHttpUrl,
  DEFAULT_BASE_URL,
  MAX_RETRY_AFTER_MS,
  MAX_RETRIES,
  parseRetryAfter,
  describeArcGisError,
  sanitizeServerText,
  isBidiControl,
} from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryValue } from "./query.js";
export {
  parseThemes,
  parseIndicators,
  filterIndicators,
  assertIndicatorFilter,
  INDICATOR_FILTER_KEYS,
  assertIndicatorInput,
  assertYearInput,
  normaliseYearFilter,
  foldText,
  resolveIndicator,
  resolveYear,
  tableForCode,
  findField,
  fieldKey,
  assertKnownFields,
  assertLevelPublished,
} from "./catalog.js";
export type { IndicatorFilter } from "./catalog.js";
export { GEO_LEVELS, LEVEL_ALIASES, DEFAULT_LEVEL, findLevel, resolveLevel, levelForTyp } from "./levels.js";
export { buildSql, buildLayerParam } from "./sql.js";
export {
  assertValid,
  assertKnownKeys,
  normalizeInput,
  isBlank,
  nonEmptyProblem,
  fieldsProblem,
  yearProblem,
  YEAR_SHAPE,
  headerValueProblem,
  headerNameProblem,
  httpUrlProblem,
  baseUrlProblem,
} from "./validate.js";
export type { Problem } from "./validate.js";
export {
  RegionalatlasError,
  RegionalatlasApiError,
  RegionalatlasNetworkError,
  RegionalatlasValidationError,
  RegionalatlasParseError,
  RegionalatlasSizeLimitError,
  sizeLimitMessage,
  redactUrl,
  cutForMessage,
  MAX_MESSAGE_VALUE_LENGTH,
  credentialsIn,
  queryTokensIn,
  redactCredentials,
  redactQueryTokens,
  SECRET_QUERY_PARAMETERS,
  shortenUrl,
} from "./errors.js";

export type { Download } from "./errors.js";
export * from "./types.js";
