import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RegionalatlasClient,
  parseRow,
  specialValueFigure,
  filterByRegion,
  projectFields,
} from "../src/client.js";
import {
  RegionalatlasApiError,
  RegionalatlasParseError,
  RegionalatlasValidationError,
  MAX_MESSAGE_VALUE_LENGTH,
} from "../src/errors.js";
import { makeMockTransport, jsonResponse, queryOf, routeByHost } from "./helpers.js";
import type { HttpRequest } from "../src/http.js";
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

test("an unknown level is rejected before any request, the catalogue included", async () => {
  const { client, mt } = clientRouting();
  await assert.rejects(
    () => client.query({ indicator: "AI002-1-5", level: "galaxy" }),
    RegionalatlasValidationError,
  );
  // An unknown indicator does not hide the bad level: the level is checked first.
  await assert.rejects(() => client.query({ indicator: "NOPE", level: "bogus" }), /Unknown geo level "bogus"/);
  assert.equal(mt.calls.length, 0);
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
  // Every value column survives, including ai0201v — the Veränderungsrate, which
  // the catalogue publishes with its own unit. Only the join columns are dropped.
  assert.deepEqual({ ...nds.values }, { ai0201: 167.8, ai0202: 12.3, ai0201v: 0.1 });
  assert.equal("ags" in nds.values, false);
  assert.equal("gen2" in nds.values, false);
});

test("parseRow accepts a number or a plain decimal string, and nothing else", () => {
  const row = parseRow(
    {
      ags: "01",
      gen: "A",
      num: 12.5,
      negative: -3,
      decimal: "12.5",
      signed: "+7",
      leadingDot: ".5",
      nul: null,
    },
    1,
    "land",
    2020,
  );
  assert.deepEqual({ ...row.values }, {
    num: 12.5,
    negative: -3,
    decimal: 12.5,
    signed: 7,
    leadingDot: 0.5,
    nul: null,
  });
});

test("parseRow never fabricates a number out of a non-value, and says so in missing", () => {
  const row = parseRow(
    {
      ags: "01",
      gen: "A",
      // Every one of these became a number under bare Number() coercion.
      yes: true,
      no: false,
      emptyArray: [],
      emptyObject: {},
      hex: "0x10",
      padded: " 7 ",
      germanComma: "12,5",
      empty: "",
      infinite: "Infinity",
      nul: null,
    },
    1,
    "land",
    2020,
  );
  assert.deepEqual(Object.values({ ...row.values }), [null, null, null, null, null, null, null, null, null, null]);
  // 2026-10-21 sweep, Bug 01-2: such a value became null silently, like "no figure here".
  assert.deepEqual({ ...row.missing }, {
    yes: "unreadable value true (not a number)",
    no: "unreadable value false (not a number)",
    emptyArray: "unreadable value (an array, not a number)",
    emptyObject: "unreadable value (an object, not a number)",
    hex: 'unreadable value "0x10" (not a number)',
    padded: 'unreadable value " 7 " (not a number)',
    germanComma: 'unreadable value "12,5" (not a number)',
    empty: 'unreadable value "" (not a number)',
    infinite: 'unreadable value "Infinity" (not a number)',
  });
  // A long or odd text is cut and shown escaped.
  const odd = parseRow({ ags: "01", gen: "A", a: "x".repeat(200), b: "a\u202eb" }, 1, "land", 2020);
  assert.equal(odd.missing?.a, `unreadable value "${"x".repeat(60)}"… (not a number)`);
  assert.equal(odd.missing?.b, 'unreadable value "a\\u202eb" (not a number)');
});

test("a decimal string in exponent form is read like a JSON number, exact or refused", () => {
  const row = parseRow({ ags: "01", gen: "A", a: "1e3", b: "1.0E-5", c: "-2.5e+2" }, 1, "land", 2020);
  assert.deepEqual({ ...row.values }, { a: 1000, b: 0.00001, c: -250 });
  assert.equal(row.missing, undefined);
  assert.throws(() => parseRow({ ags: "01", gen: "A", a: "1e400" }, 1, "land", 2020), RegionalatlasParseError);
  assert.throws(() => parseRow({ ags: "01", gen: "A", a: "12345678901234567890e0" }, 1, "land", 2020), RegionalatlasParseError);
});

test("a decimal string a double can't carry exactly is a parse error, never a changed value", () => {
  // Number() rounded "12345678901234567890" to 12345678901234567000 without a word: the engine's
  // rule for JSON number literals (printed vs written), applied to the string path.
  const huge = "1" + "0".repeat(400);
  const tiny = "0." + "0".repeat(400) + "1";
  for (const n of [
    "12345678901234567890", "-9007199254740993", "+12345678901234567890", "12345678901234567890.0",
    "9007199254740992.5", huge, tiny, "-" + tiny,
  ]) {
    assert.throws(
      () => parseRow({ ags: "01", gen: "A", ai0201: n }, 1, "land", 2020),
      (err: unknown) => {
        assert.ok(err instanceof RegionalatlasParseError, n);
        assert.equal(
          err.message,
          `the data query: the number ${n.length > MAX_MESSAGE_VALUE_LENGTH ? `${n.slice(0, MAX_MESSAGE_VALUE_LENGTH)}…` : n} in field ai0201 of region 01 cannot be represented exactly.`,
          n,
        );
        return true;
      },
      n,
    );
  }
  // What a double carries exactly passes, with any sign or a leading dot; below 2^53 a decimal
  // fraction keeps a double's precision, and 0 comes only from a zero.
  const exact: Array<[string, number]> = [
    ["9007199254740991", 9007199254740991], ["9007199254740992", 2 ** 53], ["+9007199254740992", 2 ** 53],
    ["9007199254740992.0", 2 ** 53], ["-9007199254740992", -(2 ** 53)], ["100000000000000000000000", 1e23],
    ["0", 0], ["-0.0", -0], ["+0", 0], [".0", 0], [".5", 0.5], ["1.00000000000000001", 1], ["2222222222", 2222222222],
  ];
  for (const [n, value] of exact) {
    const row = parseRow({ ags: "01", gen: "A", ai0201: n }, 1, "land", 2020);
    // Above 2,000,000,000 a value is a special-value code: `missing` carries it as read.
    if (value > 2_000_000_000 && value !== 2222222222) {
      assert.equal(row.missing?.ai0201, `Sonderwert ${String(value)} (special-value code without a label)`, n);
    } else {
      assert.equal(row.values.ai0201, value === 2222222222 ? 0 : value, n);
    }
  }
});

test("parseRow maps a non-finite number to null, so library and CLI agree", () => {
  // Infinity passes Number.isNaN, so it used to survive into `values` — where the
  // library saw Infinity and the CLI printed null, JSON.stringify having its way.
  const row = parseRow({ ags: "01", gen: "A", a: Infinity, b: -Infinity, c: NaN }, 1, "land", 2020);
  assert.deepEqual({ ...row.values }, { a: null, b: null, c: null });
  assert.equal(JSON.parse(JSON.stringify(row.values)).a, null);
});

test("a v-column is kept even though its base column is present", () => {
  const row = parseRow(
    { ags: "01", gen: "A", ai1301: 339.7, ai1301v: -0.7 },
    1,
    "land",
    2024,
  );
  // AI013-1 publishes exactly these two columns; dropping the second lost half
  // the indicator, with no way to ask for it back.
  assert.deepEqual({ ...row.values }, { ai1301: 339.7, ai1301v: -0.7 });
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

test("an ArcGIS error envelope (HTTP 200) is cut like an HTTP error's detail (B01-1)", async () => {
  // A 200 kB message and 5000 details used to give a 250 kB message (10 MB: one 10 MB record).
  const huge = { error: { code: 500, message: "A".repeat(200_000), details: Array.from({ length: 5000 }, (_, i) => `d${i}`) } };
  const { client } = clientRouting(huge);
  await assert.rejects(
    () => client.query({ indicator: "AI002-1-5", level: "land", year: 2020 }),
    (err) => {
      assert.ok(err instanceof RegionalatlasApiError);
      assert.equal(err.detail?.length, MAX_MESSAGE_VALUE_LENGTH + 1);
      assert.match(err.detail ?? "", /^A+…$/);
      assert.ok(err.message.length < 1000, `${err.message.length}`);
      // The answer itself stays on the error, whole.
      assert.ok(err.body.length > 200_000);
      return true;
    },
  );
});

// 2026-10-21 sweep, Bug 04-1: the error's `body` was built with JSON.stringify(answer), which
// overflowed the stack on Node 22 and 24 for a `details` nested 10,000 deep (a 20 KB answer):
// a bare RangeError, "Unexpected error: Maximum call stack size exceeded" on the CLI.
test("an ArcGIS error envelope nested deeply is the ArcGIS error; its body is the answer as sent", async () => {
  for (const depth of [10_000, 100_000]) {
    const text = `{ "error": { "code": 400, "message": "m", "details": ${"[".repeat(depth)}${"]".repeat(depth)} } }`;
    const mt = makeMockTransport((req) =>
      new URL(req.url).hostname.includes("statistikportal")
        ? jsonResponse(fx.catalog)
        : { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(text) },
    );
    const client = new RegionalatlasClient({ transport: mt.transport });
    await assert.rejects(
      () => client.query({ indicator: "AI002-1-5", level: "land", year: 2020 }),
      (err) => {
        assert.ok(err instanceof RegionalatlasApiError, String(err));
        assert.equal(err.arcgisCode, 400);
        assert.match(err.message, /^ArcGIS error 400 for GET https:\/\/www\.gis-idmz\.nrw\.de\/\S+: m$/);
        assert.equal(err.body, text);
        return true;
      },
    );
  }
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
    (err) =>
      err instanceof RegionalatlasParseError &&
      /^GET https:\/\/www\.gis-idmz\.nrw\.de\/\S+\/dynamicLayer\/query\?\S+: unexpected response shape: expected a JSON object, got null\.$/.test(
        err.message,
      ),
  );
});

test("a non-array features field surfaces as a typed RegionalatlasParseError, not a raw TypeError", async () => {
  const { client } = clientRouting({ features: { message: "unexpected shape" } });
  await assert.rejects(
    () => client.query({ indicator: "AI002-1-5", level: "land", year: 2020 }),
    (err) =>
      err instanceof RegionalatlasParseError &&
      /expected a features array, got an object\./.test(err.message),
  );
});

test("a null feature is a typed parse error too, not a raw TypeError", async () => {
  const { client } = clientRouting({ features: [fx.landData.features[0], null] });
  await assert.rejects(
    () => client.query({ indicator: "AI002-1-5", level: "land", year: 2020 }),
    (err) =>
      err instanceof RegionalatlasParseError && /feature 1 .*to be an object, got null/.test(err.message),
  );
});

test("a feature without an attributes object is a typed parse error", async () => {
  const { client } = clientRouting({ features: [{}] });
  await assert.rejects(
    () => client.query({ indicator: "AI002-1-5", level: "land", year: 2020 }),
    (err) => err instanceof RegionalatlasParseError && /: unexpected response shape: expected feature 0 to have an "attributes" object\.$/.test(err.message),
  );
});

test("field projection treats - and _ alike, so a catalogue spelling selects the data key", () => {
  const row = parseRow({ ags: "11", gen: "Berlin", ai_z01: 42.3, ai_z02: 43.6 }, 1, "land", 2011);
  assert.deepEqual({ ...projectFields([row], ["AI-Z01"])[0]!.values }, { ai_z01: 42.3 });
  assert.deepEqual({ ...projectFields([row], ["ai_z02"])[0]!.values }, { ai_z02: 43.6 });
});

test("a special-value code is never the code: 0 for nichts vorhanden, else null, its meaning in missing", () => {
  // Live 1998 AI005: every Land row carries ai0507 (AfD share, Prozent) = 2222222222,
  // "nichts vorhanden" — the Destatis "-", exactly zero.
  const row = parseRow(
    { ags: "09", gen: "Bayern", ai0501: 47.7, ai0507: 2222222222, ai0202: "6666666666", ai0209: 3333333333 },
    1,
    "land",
    1998,
  );
  assert.deepEqual({ ...row.values }, { ai0501: 47.7, ai0507: 0, ai0202: null, ai0209: null });
  // The string form of the code too.
  assert.deepEqual({ ...parseRow({ ags: "09", gen: "B", ai0507: "2222222222" }, 1, "land", 1998).values }, { ai0507: 0 });
  assert.equal(specialValueFigure(2222222222), 0);
  for (const code of [5555555555, 6666666666, 7777777777, 8888888888, 3333333333]) assert.equal(specialValueFigure(code), null);
  assert.deepEqual({ ...row.missing }, {
    ai0507: "nichts vorhanden",
    ai0202: "Aussage nicht sinnvoll",
    ai0209: "Sonderwert 3333333333 (special-value code without a label)",
  });
  // An ordinary row carries no missing key at all; the threshold itself is a value.
  const plain = parseRow({ ags: "09", gen: "Bayern", ai0501: 2_000_000_000, ai0502: -11 }, 1, "land", 1998);
  assert.equal(plain.missing, undefined);
  assert.deepEqual({ ...plain.values }, { ai0501: 2_000_000_000, ai0502: -11 });
  // --fields projects missing along with values.
  assert.deepEqual({ ...projectFields([row], ["ai0507"])[0]!.missing }, { ai0507: "nichts vorhanden" });
  assert.equal(projectFields([row], ["ai0501"])[0]!.missing, undefined);
});

test("a reply without features, an array or any truthy error is a failure, never zero rows", async () => {
  const q = { indicator: "AI002-1-5", level: "land", year: 2020 };
  await assert.rejects(
    () => clientRouting({ status: "maintenance" }).client.query(q),
    (err) => err instanceof RegionalatlasParseError && /expected a features array, got none\./.test(err.message),
  );
  await assert.rejects(
    () => clientRouting([]).client.query(q),
    (err) => err instanceof RegionalatlasParseError && /expected a JSON object, got an array\./.test(err.message),
  );
  await assert.rejects(
    () => clientRouting({ error: "boom" }).client.query(q),
    (err) => err instanceof RegionalatlasApiError && err.detail === "boom" && /: boom$/.test(err.message),
  );
  await assert.rejects(
    () => clientRouting({ error: true, features: [] }).client.query(q),
    (err) => err instanceof RegionalatlasApiError && err.detail === undefined,
  );
  // Repeats between message and details are dropped.
  await assert.rejects(
    () => clientRouting({ error: { code: 400, message: "Invalid URL", details: ["Invalid URL", ""] } }).client.query(q),
    (err) => err instanceof RegionalatlasApiError && err.detail === "Invalid URL",
  );
  // A null error next to an empty features array is a real, empty result.
  assert.deepEqual(await clientRouting({ error: null, features: [] }).client.query(q), []);
});

test("queryResult() reports the rows fetched before the region filter", async () => {
  const q = { indicator: "AI002-1-5", level: "land", year: 2020 };
  const hit = await clientRouting().client.queryResult({ ...q, region: "Bremen" });
  assert.equal(hit.fetched, 2);
  assert.deepEqual(hit.rows.map((r) => r.name), ["Bremen"]);
  const miss = await clientRouting().client.queryResult({ ...q, region: "Nowhere" });
  assert.deepEqual(miss, { rows: [], fetched: 2, exceededTransferLimit: false, region: { by: "none", others: [] } });
  const empty = await clientRouting({ features: [] }).client.queryResult({ ...q, region: "Bremen" });
  assert.deepEqual(empty, { rows: [], fetched: 0, exceededTransferLimit: false, region: { by: "none", others: [] } });
});

test("queryResult() passes on the host's exceededTransferLimit, only for a literal true", async () => {
  const q = { indicator: "AI002-1-5", level: "land", year: 2020 };
  const cut = await clientRouting({ ...fx.landData, exceededTransferLimit: true }).client.queryResult(q);
  assert.equal(cut.exceededTransferLimit, true);
  assert.equal(cut.rows.length, 2);
  const odd = await clientRouting({ ...fx.landData, exceededTransferLimit: "true" }).client.queryResult(q);
  assert.equal(odd.exceededTransferLimit, false);
});

test("region filter matches a decomposed (NFD) umlaut in the name", () => {
  const rows = [
    parseRow({ ags: "05", gen: "Nordrhein-Westfalen" }, 1, "land", 2020),
    parseRow({ ags: "08", gen: "Baden-Württemberg" }, 1, "land", 2020),
  ];
  assert.deepEqual(filterByRegion(rows, "württemberg").map((r) => r.ags), ["08"]);
});

test("an ArcGIS error names the query URL without the long encoded layer, reason in reach", async () => {
  const { client } = clientRouting({
    error: { code: 400, message: "Unable to complete operation.", details: ["Invalid SQL"] },
  });
  await assert.rejects(
    () => client.query({ indicator: "AI002-1-5", level: "land", year: 2020 }),
    (err) => {
      assert.ok(err instanceof RegionalatlasApiError);
      assert.equal(
        err.message,
        "ArcGIS error 400 for GET https://www.gis-idmz.nrw.de/arcgis/rest/services/stba/regionalatlas/" +
          "MapServer/dynamicLayer/query?layer=…&f=json&outFields=*&returnGeometry=false&where=1%3D1" +
          "&spatialRel=esriSpatialRelIntersects: Unable to complete operation.; Invalid SQL",
      );
      // The full URL, SQL included, stays on the error for a caller who needs it.
      assert.match(err.url, /layer=%7B.*ai002_1_5/);
      return true;
    },
  );
});
