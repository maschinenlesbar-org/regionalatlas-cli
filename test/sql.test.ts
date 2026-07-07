import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSql, buildLayerParam } from "../src/client/sql.js";
import { resolveLevel } from "../src/client/levels.js";

test("buildSql interpolates only the table, typ and year", () => {
  const sql = buildSql("ai002_1_5", 1, 2020);
  assert.equal(
    sql,
    "SELECT * FROM verwaltungsgrenzen_gesamt " +
      "LEFT OUTER JOIN ai002_1_5 ON ags = ags2 and jahr = jahr2 " +
      "WHERE typ = 1 AND jahr = 2020 AND (jahr2 = 2020 OR jahr2 IS NULL)",
  );
});

test("the built SQL contains ONLY the allowlisted table plus the integer typ/year", () => {
  const sql = buildSql("ai002_1_5", 3, 2022);
  assert.match(sql, /LEFT OUTER JOIN ai002_1_5 ON/);
  assert.match(sql, /typ = 3 AND jahr = 2022/);
  // No stray SQL metacharacters that would indicate injected text.
  assert.doesNotMatch(sql, /;|--|\bDROP\b|\bUNION\b|'/i);
});

test("buildSql refuses a table name that is not a valid catalogue table", () => {
  // These can never come from a matched catalogue entry, but the assert is the
  // last line of defence against a future refactor routing raw text into SQL.
  assert.throws(() => buildSql("ai002_1_5; DROP TABLE x", 1, 2020), /valid catalogue table/);
  assert.throws(() => buildSql("verwaltungsgrenzen_gesamt WHERE 1=1", 1, 2020), /valid catalogue table/);
  assert.throws(() => buildSql("AI002-1-5", 1, 2020), /valid catalogue table/); // uppercase/hyphen not a table
});

test("buildSql refuses a typ outside the fixed allowlist", () => {
  assert.throws(() => buildSql("ai002_1_5", 4, 2020), /allowed geo level/);
  assert.throws(() => buildSql("ai002_1_5", 99, 2020), /allowed geo level/);
});

test("buildSql refuses a non-4-digit-integer year", () => {
  assert.throws(() => buildSql("ai002_1_5", 1, 2020.5), /4-digit integer/);
  assert.throws(() => buildSql("ai002_1_5", 1, 20200), /4-digit integer/);
});

test("buildLayerParam embeds the SQL in a queryTable data source with wkid 25832", () => {
  const layer = buildLayerParam("ai002_1_5", resolveLevel("land").typ, 2020) as {
    source: { dataSource: { type: string; query: string; spatialReference: { wkid: number } } };
  };
  assert.equal(layer.source.dataSource.type, "queryTable");
  assert.equal(layer.source.dataSource.spatialReference.wkid, 25832);
  assert.match(layer.source.dataSource.query, /JOIN ai002_1_5 ON/);
  assert.match(layer.source.dataSource.query, /typ = 1 AND jahr = 2020/);
});
