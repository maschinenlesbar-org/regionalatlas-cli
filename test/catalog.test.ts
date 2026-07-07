import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterIndicators,
  parseIndicators,
  parseThemes,
  resolveIndicator,
  resolveYear,
  tableForCode,
} from "../src/client/catalog.js";
import { RegionalatlasValidationError } from "../src/client/errors.js";
import * as fx from "./fixtures.js";

test("tableForCode lowercases and replaces hyphens with underscores", () => {
  assert.equal(tableForCode("AI002-1-5"), "ai002_1_5");
  assert.equal(tableForCode("AI001-2-5"), "ai001_2_5");
});

test("parseThemes returns each theme with its indicator count", () => {
  const themes = parseThemes(fx.catalog);
  assert.deepEqual(themes, [
    { title: "Gebiet und Fläche", indicatorCount: 1 },
    { title: "Bevölkerung", indicatorCount: 2 },
  ]);
});

test("parseIndicators flattens the catalogue with table + theme + sorted years", () => {
  const indicators = parseIndicators(fx.catalog);
  assert.equal(indicators.length, 3);
  const ai002 = indicators.find((i) => i.code === "AI002-1-5");
  assert.ok(ai002);
  assert.equal(ai002.table, "ai002_1_5");
  assert.equal(ai002.theme, "Bevölkerung");
  assert.deepEqual(ai002.years, ["2000", "2020", "2024"]);
});

test("parseThemes/parseIndicators reject a non-array catalogue", () => {
  assert.throws(() => parseThemes({} as unknown), /expected a JSON array/i);
  assert.throws(() => parseIndicators("nope" as unknown), /expected a JSON array/i);
});

test("filterIndicators: theme substring is case-insensitive", () => {
  const all = parseIndicators(fx.catalog);
  const res = filterIndicators(all, { theme: "bevölk" });
  assert.equal(res.length, 2);
  assert.ok(res.every((i) => i.theme === "Bevölkerung"));
});

test("filterIndicators: year membership", () => {
  const all = parseIndicators(fx.catalog);
  const res = filterIndicators(all, { year: 2024 });
  assert.deepEqual(res.map((i) => i.code), ["AI002-1-5"]);
});

test("filterIndicators: search over code + short + long title", () => {
  const all = parseIndicators(fx.catalog);
  assert.deepEqual(filterIndicators(all, { search: "ALTERSGRUPPEN" }).map((i) => i.code), ["AI002-2-5"]);
  assert.deepEqual(filterIndicators(all, { search: "ai002-1-5" }).map((i) => i.code), ["AI002-1-5"]);
});

test("resolveIndicator accepts the code form (case-insensitive, hyphen or underscore)", () => {
  const all = parseIndicators(fx.catalog);
  assert.equal(resolveIndicator(all, "AI002-1-5").table, "ai002_1_5");
  assert.equal(resolveIndicator(all, "ai002-1-5").table, "ai002_1_5");
  assert.equal(resolveIndicator(all, "AI002_1_5").table, "ai002_1_5");
});

test("resolveIndicator accepts the table form", () => {
  const all = parseIndicators(fx.catalog);
  assert.equal(resolveIndicator(all, "ai002_1_5").code, "AI002-1-5");
});

test("resolveIndicator rejects a bogus code with a typed validation error", () => {
  const all = parseIndicators(fx.catalog);
  assert.throws(() => resolveIndicator(all, "AI999-9-9"), RegionalatlasValidationError);
  // Injection attempts are just "unknown indicators" — rejected the same way.
  assert.throws(() => resolveIndicator(all, "ai002_1_5; DROP TABLE x"), RegionalatlasValidationError);
  assert.throws(() => resolveIndicator(all, "verwaltungsgrenzen_gesamt"), RegionalatlasValidationError);
});

test("resolveYear defaults to the latest available year when omitted", () => {
  const ind = parseIndicators(fx.catalog).find((i) => i.code === "AI002-1-5")!;
  assert.equal(resolveYear(ind), 2024);
});

test("resolveYear accepts a year present in the indicator's list", () => {
  const ind = parseIndicators(fx.catalog).find((i) => i.code === "AI002-1-5")!;
  assert.equal(resolveYear(ind, 2020), 2020);
});

test("resolveYear rejects a non-integer or out-of-range year", () => {
  const ind = parseIndicators(fx.catalog).find((i) => i.code === "AI002-1-5")!;
  assert.throws(() => resolveYear(ind, 2019), RegionalatlasValidationError); // not in list
  assert.throws(() => resolveYear(ind, 2020.5), RegionalatlasValidationError); // non-integer
});
