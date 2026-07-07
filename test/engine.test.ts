import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine } from "../src/client/engine.js";
import {
  RegionalatlasApiError,
  RegionalatlasNetworkError,
  RegionalatlasParseError,
} from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, rawResponse, queryOf } from "./helpers.js";
import * as fx from "./fixtures.js";

test("buildUrl appends the path and query string on the data host", () => {
  const e = new RequestEngine({ baseUrl: "https://example.test/" });
  assert.equal(e.buildUrl("/x/query", { where: "1=1" }), "https://example.test/x/query?where=1%3D1");
  assert.equal(e.buildUrl("y"), "https://example.test/y");
});

test("buildAbsoluteUrl keeps an absolute URL and appends query with the right separator", () => {
  const e = new RequestEngine();
  assert.equal(e.buildAbsoluteUrl("https://cat.test/services.json"), "https://cat.test/services.json");
  assert.equal(e.buildAbsoluteUrl("https://cat.test/s.json", { a: 1 }), "https://cat.test/s.json?a=1");
  assert.equal(e.buildAbsoluteUrl("https://cat.test/s.json?x=1", { a: 2 }), "https://cat.test/s.json?x=1&a=2");
});

test("getJson performs a GET with query params and the User-Agent/Accept headers", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.landData));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "ua/1" });
  await e.getJson("/x/query", { where: "1=1", f: "json" });
  const req = mt.last();
  assert.equal(req.method, "GET");
  assert.equal(req.headers?.["Accept"], "application/json");
  assert.equal(req.headers?.["User-Agent"], "ua/1");
  assert.equal(queryOf(req).get("where"), "1=1");
});

test("getJsonAbsolute GETs the given absolute URL (the catalogue host)", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.catalog));
  const e = new RequestEngine({ transport: mt.transport, baseUrl: "https://data.test" });
  const raw = await e.getJsonAbsolute<unknown[]>("https://cat.test/services.json");
  assert.equal(new URL(mt.last().url).hostname, "cat.test");
  assert.ok(Array.isArray(raw));
});

test("getJson parses and returns the JSON body", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.landData));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson("/x/query"), fx.landData);
});

test("getJson returns null on an empty/204 body", async () => {
  const mt = makeMockTransport(() => rawResponse("", "application/json", 204));
  const e = new RequestEngine({ transport: mt.transport });
  assert.equal(await e.getJson("/x"), null);
});

test("getJson throws RegionalatlasParseError on invalid JSON", async () => {
  const mt = makeMockTransport(() => rawResponse("not json", "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson("/x"), RegionalatlasParseError);
});

test("a non-2xx surfaces as a RegionalatlasApiError with the parsed error.message", async () => {
  const mt = makeMockTransport(() => jsonResponse({ error: { message: "kaputt" } }, 400));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof RegionalatlasApiError && err.status === 400 && /kaputt/.test(err.message),
  );
});

// Control characters are built via char codes so no raw control byte ever appears
// in this source file.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const C1 = String.fromCharCode(0x9b); // a C1 control (CSI)

/** True if the string contains any C0/C1 control char except tab/newline. */
function hasControlChars(s: string): boolean {
  return [...s].some((c) => {
    const n = c.charCodeAt(0);
    return n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f);
  });
}

test("a JSON error detail is stripped of terminal control characters", async () => {
  const evil = `boom${ESC}[31mred${BEL}${C1}2J`;
  const mt = makeMockTransport(() => jsonResponse({ error: { message: evil } }, 500));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => {
      assert.ok(err instanceof RegionalatlasApiError);
      assert.ok(!hasControlChars(err.detail ?? ""));
      assert.ok(!hasControlChars(err.message));
      assert.equal(err.detail, "boom[31mred2J");
      return true;
    },
  );
});

test("a 503 is retried up to maxRetries then surfaces as a RegionalatlasApiError", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return jsonResponse({ error: { message: "busy" } }, 503);
  });
  const e = new RequestEngine({ transport: mt.transport, maxRetries: 2, sleep: async () => {} });
  await assert.rejects(() => e.getJson("/x"), (err) => err instanceof RegionalatlasApiError && err.status === 503);
  assert.equal(calls, 3);
});

test("requestUrl rejects a non-http(s) scheme at the engine level, before the transport", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.landData));
  // Data host with a file: base URL — a library consumer injecting a custom
  // transport would otherwise never hit a scheme check.
  const e1 = new RequestEngine({ transport: mt.transport, baseUrl: "file:///etc/passwd" });
  await assert.rejects(() => e1.getJson("/x/query"), RegionalatlasNetworkError);
  // Absolute (catalogue) URL with an ftp: scheme.
  const e2 = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e2.getJsonAbsolute("ftp://cat.test/services.json"),
    RegionalatlasNetworkError,
  );
  // The transport was never invoked in either case.
  assert.equal(mt.calls.length, 0);
});
