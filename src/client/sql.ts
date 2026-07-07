// Builds the ArcGIS `dynamicLayer` JSON that embeds the raw SQL join for a data
// query. This is the security-critical file: the SQL is assembled here, and every
// value it interpolates MUST already be validated:
//   - `table` is the `Indicator.table` of a catalogue-matched entry (allowlist),
//   - `typ` is one of the fixed integers 1/2/3/5 (from levels.ts),
//   - `year` is a validated integer present in the indicator's catalogue years.
// No raw user text (region filter, field names) ever reaches this file — those are
// applied client-side.

import type { GeoLevel } from "./types.js";

/**
 * Extra defence-in-depth: assert the pieces are exactly the shape we expect right
 * before they enter the SQL string. These should never fire when called through the
 * client (the catalogue + levels layers already guarantee them), but a hard assert
 * here means a future refactor cannot accidentally route unvalidated text into SQL.
 */
function assertSafeTable(table: string): void {
  // A catalogue table name is lowercase letters, digits and underscores only.
  if (!/^[a-z0-9_]+$/.test(table)) {
    throw new Error(`Refusing to build SQL: table "${table}" is not a valid catalogue table name.`);
  }
}

function assertSafeTyp(typ: number): asserts typ is GeoLevel {
  if (typ !== 1 && typ !== 2 && typ !== 3 && typ !== 5) {
    throw new Error(`Refusing to build SQL: typ ${typ} is not an allowed geo level.`);
  }
}

function assertSafeYear(year: number): void {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) {
    throw new Error(`Refusing to build SQL: year ${year} is not a 4-digit integer.`);
  }
}

/**
 * Build the raw SQL SELECT that joins the administrative-boundary table to the
 * indicator table. Only the pre-validated `table`, `typ` and `year` are interpolated.
 */
export function buildSql(table: string, typ: number, year: number): string {
  assertSafeTable(table);
  assertSafeTyp(typ);
  assertSafeYear(year);
  return (
    `SELECT * FROM verwaltungsgrenzen_gesamt ` +
    `LEFT OUTER JOIN ${table} ON ags = ags2 and jahr = jahr2 ` +
    `WHERE typ = ${typ} AND jahr = ${year} AND (jahr2 = ${year} OR jahr2 IS NULL)`
  );
}

/**
 * Build the ArcGIS `layer` parameter (a JSON object) that wraps the SQL query as a
 * `queryTable` data source. Returned as an object; the caller JSON-stringifies it
 * for the `layer=` query param.
 */
export function buildLayerParam(table: string, typ: number, year: number): unknown {
  const query = buildSql(table, typ, year);
  return {
    source: {
      type: "dataLayer",
      dataSource: {
        type: "queryTable",
        geometryType: "esriGeometryPolygon",
        workspaceId: "gdb",
        oidFields: "id",
        spatialReference: { wkid: 25832 },
        query,
      },
    },
  };
}
