// The geographic-level (Gebietstyp / `typ`) allowlist. Friendly names map onto a
// fixed set of integers; ONLY the resolved integer `typ` is ever interpolated into
// the SQL query. An unknown level is rejected before any SQL is built.

import type { GeoLevel, GeoLevelInfo } from "./types.js";
import { RegionalatlasValidationError, cutForMessage } from "./errors.js";
import { normalizeInput } from "./validate.js";

/** The canonical level definitions (order defines display order). */
export const GEO_LEVELS: readonly GeoLevelInfo[] = [
  { name: "land", typ: 1, label: "Bundesländer" },
  { name: "regierungsbezirk", typ: 2, label: "Regierungsbezirke" },
  { name: "kreis", typ: 3, label: "Kreise / kreisfreie Städte" },
  { name: "gemeinde", typ: 5, label: "Gemeinden" },
];

/**
 * All accepted aliases → the canonical name. Kept small and explicit so the mapping
 * is auditable; the CLI value-parser also uses these keys for its choices.
 */
const ALIASES: Readonly<Record<string, string>> = {
  land: "land",
  laender: "land",
  "länder": "land",
  bundesland: "land",
  bundeslaender: "land",
  "bundesländer": "land",

  regierungsbezirk: "regierungsbezirk",
  regierungsbezirke: "regierungsbezirk",
  rb: "regierungsbezirk",

  kreis: "kreis",
  kreise: "kreis",
  landkreis: "kreis",
  landkreise: "kreis",

  gemeinde: "gemeinde",
  gemeinden: "gemeinde",
};

/** Every alias a user may type for a level (for CLI help / completion). */
export const LEVEL_ALIASES: readonly string[] = Object.keys(ALIASES);

/**
 * The geo level a query uses when none is given: `land`, the coarsest level, which
 * every indicator publishes. `query`/`queryResult` apply it to an omitted level, and
 * the CLI's `--level` shows it as its default.
 */
export const DEFAULT_LEVEL = "land";

/**
 * Look up a canonical level by friendly name/alias, or return undefined. A
 * non-string input (a plain-JS caller's `null` or number) is not a level either.
 */
export function findLevel(input: unknown): GeoLevelInfo | undefined {
  if (typeof input !== "string") return undefined;
  // Trimmed, NFC (a decomposed "ä" in "bundesländer") and case-folded.
  const key = normalizeInput(input).toLowerCase();
  if (!Object.hasOwn(ALIASES, key)) return undefined;
  const canonical = ALIASES[key];
  if (canonical === undefined) return undefined;
  return GEO_LEVELS.find((l) => l.name === canonical);
}

/**
 * Resolve a friendly level name to its info, throwing a typed validation error for
 * an unknown level. The returned `typ` is one of the fixed integers 1/2/3/5 — the
 * only value that ends up in SQL.
 */
export function resolveLevel(input: unknown): GeoLevelInfo {
  const level = findLevel(input);
  if (level === undefined) {
    const names = GEO_LEVELS.map((l) => l.name).join(", ");
    throw new RegionalatlasValidationError(
      `Unknown geo level "${cutForMessage(String(input))}". Use one of: ${names} (aliases: ${LEVEL_ALIASES.join(", ")}).`,
    );
  }
  return level;
}

/** Get the info for a raw `typ` integer, or undefined if not a known level. */
export function levelForTyp(typ: number): GeoLevelInfo | undefined {
  return GEO_LEVELS.find((l) => l.typ === (typ as GeoLevel));
}
