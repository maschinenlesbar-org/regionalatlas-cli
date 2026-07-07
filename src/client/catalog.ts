// The indicator catalogue: parse the raw services.json into flat `Theme`/
// `Indicator` lists, filter them, and — crucially — resolve a user-supplied
// indicator string against the catalogue allowlist.
//
// The catalogue is the security boundary for the raw SQL query: the only table
// name ever interpolated into SQL is the `table` of a *matched* catalogue entry,
// never raw user text.

import type {
  Indicator,
  RawCatalog,
  RawCatalogIndicator,
  RawCatalogTheme,
  Theme,
} from "./types.js";
import { RegionalatlasParseError, RegionalatlasValidationError } from "./errors.js";

/** Derive the SQL table name from a catalogue code: lowercase, `-` → `_`. */
export function tableForCode(code: string): string {
  return code.toLowerCase().replace(/-/g, "_");
}

/** Normalise a user indicator string to compare against a code or a table form. */
function normalizeIndicatorKey(input: string): string {
  return input.trim().toLowerCase().replace(/-/g, "_");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Parse the raw services.json array into a flat list of indicators. */
export function parseIndicators(raw: unknown): Indicator[] {
  if (!Array.isArray(raw)) {
    throw new RegionalatlasParseError(
      "Unexpected catalogue shape: expected a JSON array of themes from services.json.",
    );
  }
  const catalog = raw as RawCatalog;
  const out: Indicator[] = [];
  for (const theme of catalog) {
    if (theme === null || typeof theme !== "object") continue;
    const t = theme as RawCatalogTheme;
    const themeTitle = asString(t.title);
    const children = Array.isArray(t.children) ? t.children : [];
    for (const child of children) {
      if (child === null || typeof child !== "object") continue;
      const c = child as RawCatalogIndicator;
      const code = asString(c.code);
      if (code === "") continue;
      const years =
        c.years && typeof c.years === "object" ? Object.keys(c.years).sort() : [];
      out.push({
        code,
        table: tableForCode(code),
        theme: themeTitle,
        titleShort: asString(c.title_short),
        titleLong: asString(c.title_long),
        years,
      });
    }
  }
  return out;
}

/** Parse the raw services.json into a list of themes with their indicator counts. */
export function parseThemes(raw: unknown): Theme[] {
  if (!Array.isArray(raw)) {
    throw new RegionalatlasParseError(
      "Unexpected catalogue shape: expected a JSON array of themes from services.json.",
    );
  }
  const catalog = raw as RawCatalog;
  return catalog
    .filter((t): t is RawCatalogTheme => t !== null && typeof t === "object")
    .map((t) => ({
      title: asString(t.title),
      indicatorCount: Array.isArray(t.children) ? t.children.length : 0,
    }));
}

/** Filters for listing indicators. */
export interface IndicatorFilter {
  /** Case-insensitive substring on the theme title. */
  theme?: string;
  /** Membership: the indicator must offer this year. */
  year?: string | number;
  /** Case-insensitive substring over code + short + long titles. */
  search?: string;
}

/** Apply the (optional) filters to a flat indicator list. */
export function filterIndicators(indicators: Indicator[], filter: IndicatorFilter = {}): Indicator[] {
  const theme = filter.theme?.trim().toLowerCase();
  const search = filter.search?.trim().toLowerCase();
  const year = filter.year !== undefined ? String(filter.year) : undefined;

  return indicators.filter((ind) => {
    if (theme && !ind.theme.toLowerCase().includes(theme)) return false;
    if (year && !ind.years.includes(year)) return false;
    if (search) {
      const hay = `${ind.code} ${ind.titleShort} ${ind.titleLong}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

/**
 * Resolve a user-supplied indicator string against the catalogue allowlist. Accepts
 * either the code form (`AI002-1-5`, case-insensitive) or the table form
 * (`ai002_1_5`). Throws a typed validation error if not found — BEFORE any SQL is
 * built. The returned indicator's `table` is the only value interpolated into SQL.
 */
export function resolveIndicator(indicators: Indicator[], input: string): Indicator {
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new RegionalatlasValidationError("An indicator code is required (e.g. AI002-1-5).");
  }
  const key = normalizeIndicatorKey(trimmed);
  // A code's normalized form equals its table form, so one key matches both the
  // code (case-insensitive, hyphen or underscore) and the table name.
  const match = indicators.find((ind) => ind.table === key);
  if (match === undefined) {
    throw new RegionalatlasValidationError(
      `Unknown indicator "${input}". It is not in the catalogue — list indicators with ` +
        `\`regionalatlas indicators\` (accepts the code form AI002-1-5 or the table form ai002_1_5).`,
    );
  }
  return match;
}

/**
 * Validate and resolve the year for an indicator. When `year` is undefined, the
 * latest available year is used. A provided year must be an integer AND present in
 * the indicator's catalogue years. Only the validated integer enters SQL.
 */
export function resolveYear(indicator: Indicator, year?: number): number {
  if (indicator.years.length === 0) {
    throw new RegionalatlasValidationError(
      `Indicator "${indicator.code}" has no years listed in the catalogue.`,
    );
  }
  if (year === undefined) {
    // Latest available year (years are 4-digit strings; compare numerically).
    return Math.max(...indicator.years.map((y) => Number(y)));
  }
  if (!Number.isInteger(year)) {
    throw new RegionalatlasValidationError(`Year must be an integer, got "${year}".`);
  }
  if (!indicator.years.includes(String(year))) {
    throw new RegionalatlasValidationError(
      `Year ${year} is not available for indicator "${indicator.code}". ` +
        `Available: ${indicator.years.join(", ")}.`,
    );
  }
  return year;
}
