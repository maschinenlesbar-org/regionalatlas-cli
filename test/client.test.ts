import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RegionalatlasClient,
  parseRow,
  filterByRegion,
  projectFields,
} from "../src/client/client.js";
import {
  RegionalatlasApiError,
  RegionalatlasParseError,
  RegionalatlasValidationError,
} from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, queryOf, routeByHost } from "./helpers.js";
import type { HttpRequest } from "../src/client/http.js";
import * as fx from "./fixtures.js";

/** A client wired to a host-routing transport (catalogue + data). */
function clientRouting(data: unknown = fx.landData) {
  const mt = makeMockTransport(routeByHost(fx.catalog, data));
  return { client: new RegionalatlasClient({ transport: mt.transport }), mt };
}

/** Recover the ArcGIS data request (the one to the gis-idmz host). */
function dataRequest(calls: HttpRequest[]): HttpRequest {
  const req = calls.find((c) => new URL(c.url).hostname.includes("gis-idmz"));
  if (!req) throw new Error("no data request was made");
  return req;
}

// --------------------------------------------------------------------------
// themes / indicators (catalogue)
// --------------------------------------------------------------------------

test("themes() returns the subject areas with indicator counts", async () => {
  const { client } = clientRouting();
  const themes = await client.themes();
  assert.deepEqual(themes, [
    { title: "Gebiet und Fläche", indicatorCount: 1 },
    { title: "Bevölkerung", indicatorCount: 2 },
  ]);
});

test("indicators() lists and filters the catalogue", async () => {
  const { client } = clientRouting();
  const all = await client.indicators();
  assert.equal(all.length, 3);
  const pop = await client.indicators({ search: "bevölkerung" });
  assert.ok(pop.length >= 1);
  assert.ok(pop.every((i) => /bevölkerung/i.test(`${i.theme} ${i.titleLong}`)));
});

// --------------------------------------------------------------------------
// query — the injection guard through the client + SQL contents
// --------------------------------------------------------------------------

test("query() builds SQL with only the allowlisted table + integer typ/year", async () => {
  const { client, mt } = clientRouting();
  const rows = await client.query({ indicator: "AI002-1-5", level: "land", year: 2020 });
  const req = dataRequest(mt.calls);
  const layer = JSON.parse(queryOf(req).get("layer") ?? "{}") as {
    source: { dataSource: { query: string } };
  };
  const sql = layer.source.dataSource.query;
  assert.match(sql, /JOIN ai002_1_5 ON/);
  assert.match(sql, /typ = 1 AND jahr = 2020/);
  assert.doesNotMatch(sql, /;|--|'/); // no injected metacharacters
  // Standard params.
  assert.equal(queryOf(req).get("f"), "json");
  assert.equal(queryOf(req).get("outFields"), "*");
  assert.equal(queryOf(req).get("returnGeometry"), "false");
  assert.equal(rows.length, 2);
});

test("query() defaults to the latest available year when --year is omitted", async () => {
  const { client, mt } = clientRouting();
  await client.query({ indicator: "AI002-1-5", level: "land" });
  const layer = JSON.parse(queryOf(dataRequest(mt.calls)).get("layer") ?? "{}") as {
    source: { dataSource: { query: string } };
  };
  assert.match(layer.source.dataSource.query, /jahr = 2024/); // latest in the fixture
});

test("a bogus indicator code is rejected and NEVER reaches the data transport", async () => {
  const { client, mt } = clientRouting();
  await assert.rejects(
    () => client.query({ indicator: "AI999-9-9", level: "land" }),
    RegionalatlasValidationError,
  );
  // The catalogue may have been fetched, but no request ever hit the data host.
  assert.equal(mt.calls.some((c) => new URL(c.url).hostname.includes("gis-idmz")), false);
});

test("an injection-shaped indicator is rejected before any data request", async () => {
  const { client, mt } = clientRouting();
  await assert.rejects(
    () => client.query({ indicator: "ai002_1_5; DROP TABLE verwaltungsgrenzen_gesamt", level: "land" }),
    RegionalatlasValidationError,
  );
  assert.equal(mt.calls.some((c) => new URL(c.url).hostname.includes("gis-idmz")), false);
});

test("an unknown level is rejected and no data request is made", async () => {
  const { client, mt } = clientRouting();
  await assert.rejects(
    () => client.query({ indicator: "AI002-1-5", level: "galaxy" }),
    RegionalatlasValidationError,
  );
  assert.equal(mt.calls.some((c) => new URL(c.url).hostname.includes("gis-idmz")), false);
});

test("an out-of-range or non-integer year is rejected and no data request is made", async () => {
  const { client, mt } = clientRouting();
  await assert.rejects(
    () => client.query({ indicator: "AI002-1-5", level: "land", year: 1999 }),
    RegionalatlasValidationError,
  );
  await assert.rejects(
    () => client.query({ indicator: "AI002-1-5", level: "land", year: 2020.5 }),
    RegionalatlasValidationError,
  );
  assert.equal(mt.calls.some((c) => new URL(c.url).hostname.includes("gis-idmz")), false);
});

// --------------------------------------------------------------------------
// row parsing, region filter, field projection
// --------------------------------------------------------------------------

test("query() parses rows: trims gen2/name, drops join + <field>v columns", async () => {
  const { client } = clientRouting();
  const rows = await client.query({ indicator: "AI002-1-5", level: "land", year: 2020 });
  const nds = rows.find((r) => r.ags === "03")!;
  assert.equal(nds.name, "Niedersachsen");
  assert.equal(nds.typ, 1);
  assert.equal(nds.level, "land");
  assert.equal(nds.year, 2020);
  assert.deepEqual({ ...nds.values }, { ai0201: 167.8, ai0202: 12.3 }); // ai0201v flag dropped
  assert.equal("ags" in nds.values, false);
});

test("region filter: a numeric input matches AGS ignoring leading zeros", () => {
  const rows = [fx.landData.features[0]!, fx.landData.features[1]!].map((f) =>
    parseRow(f.attributes, 1, "land", 2020),
  );
  assert.deepEqual(filterByRegion(rows, "3").map((r) => r.ags), ["03"]);
  assert.deepEqual(filterByRegion(rows, "03").map((r) => r.ags), ["03"]);
});

test("region filter: a text input is a case-insensitive substring of the name", () => {
  const rows = [fx.landData.features[0]!, fx.landData.features[1]!].map((f) =>
    parseRow(f.attributes, 1, "land", 2020),
  );
  assert.deepEqual(filterByRegion(rows, "bremen").map((r) => r.name), ["Bremen"]);
});

test("field projection keeps only named value fields and ignores unknown names", () => {
  const rows = [fx.landData.features[0]!].map((f) => parseRow(f.attributes, 1, "land", 2020));
  const projected = projectFields(rows, ["ai0201", "does_not_exist"]);
  assert.deepEqual({ ...projected[0]!.values }, { ai0201: 167.8 });
});

test("a __proto__/constructor field in the response cannot pollute Object.prototype", () => {
  // JSON.parse creates "__proto__" as an OWN property (this is the real transport
  // path), unlike an object literal which would invoke the prototype setter.
  const attrs = JSON.parse(
    '{"ags":"03","gen":"Test","ai0201":5,"__proto__":{"polluted":"yes"},"constructor":{"polluted":"yes"}}',
  );
  const row = parseRow(attrs, 1, "land", 2020);
  // Object.prototype is untouched and the value map has a null prototype.
  assert.equal((({}) as Record<string, unknown>)["polluted"], undefined);
  assert.equal(
    Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"),
    false,
  );
  assert.equal(Object.getPrototypeOf(row.values), null);
  // The legitimate data is still parsed.
  assert.equal(row.ags, "03");
  assert.equal(row.name, "Test");
  assert.equal(row.values.ai0201, 5);
});

test("query() applies --region and --fields client-side without changing the request", async () => {
  const { client, mt } = clientRouting();
  const rows = await client.query({
    indicator: "AI002-1-5",
    level: "land",
    year: 2020,
    region: "Bremen",
    fields: ["ai0201"],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.name, "Bremen");
  assert.deepEqual({ ...rows[0]!.values }, { ai0201: 1620.8 });
  // The request still asked for all fields, all regions.
  assert.equal(queryOf(dataRequest(mt.calls)).get("outFields"), "*");
});

// --------------------------------------------------------------------------
// ArcGIS error-in-200-body mapping
// --------------------------------------------------------------------------

test("an ArcGIS error envelope (HTTP 200) throws RegionalatlasApiError", async () => {
  const { client } = clientRouting(fx.arcgisError);
  await assert.rejects(
    () => client.query({ indicator: "AI002-1-5", level: "land", year: 2020 }),
    (err) =>
      err instanceof RegionalatlasApiError &&
      err.arcgisCode === 400 &&
      /Invalid or missing input parameters/.test(err.message),
  );
});

test("an ArcGIS error envelope with control chars is stripped before it reaches stderr", async () => {
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const evil = { error: { code: 400, message: `bad${ESC}[2Jclause`, details: [`hint${BEL}here`] } };
  const { client } = clientRouting(evil);
  await assert.rejects(
    () => client.query({ indicator: "AI002-1-5", level: "land", year: 2020 }),
    (err) => {
      assert.ok(err instanceof RegionalatlasApiError);
      const hasControl = [...err.message].some((c) => {
        const n = c.charCodeAt(0);
        return n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f);
      });
      assert.ok(!hasControl);
      assert.match(err.message, /bad\[2Jclause/);
      assert.match(err.message, /hinthere/);
      return true;
    },
  );
});

test("an empty 200 data body surfaces as a typed RegionalatlasParseError", async () => {
  const mt = makeMockTransport((req) =>
    new URL(req.url).hostname.includes("statistikportal")
      ? jsonResponse(fx.catalog)
      : jsonResponse(null),
  );
  const client = new RegionalatlasClient({ transport: mt.transport });
  await assert.rejects(
    () => client.query({ indicator: "AI002-1-5", level: "land", year: 2020 }),
    (err) => err instanceof RegionalatlasParseError && /Expected a JSON object/.test(err.message),
  );
});
