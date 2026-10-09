import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RequestEngine,
  assertHeaderValue,
  parseRetryAfter,
  sanitizeServerText,
  type EngineOptions,
} from "../src/client/engine.js";
import {
  RegionalatlasApiError,
  RegionalatlasNetworkError,
  RegionalatlasParseError,
  RegionalatlasValidationError,
  cutText,
  toWellFormed,
} from "../src/client/errors.js";
import { RegionalatlasClient } from "../src/client/client.js";
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

test("a retry honours Retry-After in seconds, clamped to 30s", async () => {
  const slept: number[] = [];
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1
      ? rawResponse("slow down", "text/plain", 429, { "retry-after": "5" })
      : jsonResponse(fx.landData);
  });
  const e = new RequestEngine({
    transport: mt.transport,
    maxRetries: 2,
    retryDelayMs: 200,
    sleep: async (ms) => void slept.push(ms),
  });
  await e.getJson("/x");
  assert.deepEqual(slept, [5000]);

  // A server-controlled header must not park the CLI for a day.
  slept.length = 0;
  calls = 0;
  const long = makeMockTransport(() => {
    calls += 1;
    return calls === 1
      ? rawResponse("slow down", "text/plain", 503, { "retry-after": "86400" })
      : jsonResponse(fx.landData);
  });
  const e2 = new RequestEngine({
    transport: long.transport,
    maxRetries: 2,
    sleep: async (ms) => void slept.push(ms),
  });
  await e2.getJson("/x");
  assert.deepEqual(slept, [30_000]);
});

test("a retry honours Retry-After as an HTTP-date, and ignores an unparseable one", async () => {
  const slept: number[] = [];
  let calls = 0;
  const when = new Date(Date.now() + 4000).toUTCString();
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1
      ? rawResponse("slow down", "text/plain", 429, { "retry-after": when })
      : jsonResponse(fx.landData);
  });
  const e = new RequestEngine({
    transport: mt.transport,
    maxRetries: 2,
    sleep: async (ms) => void slept.push(ms),
  });
  await e.getJson("/x");
  assert.ok(slept[0]! > 2000 && slept[0]! <= 4000, `expected ~4000ms, got ${slept[0]}`);

  // Garbage falls back to linear backoff rather than to zero.
  slept.length = 0;
  calls = 0;
  const bad = makeMockTransport(() => {
    calls += 1;
    return calls === 1
      ? rawResponse("slow down", "text/plain", 429, { "retry-after": "soon-ish" })
      : jsonResponse(fx.landData);
  });
  const e2 = new RequestEngine({
    transport: bad.transport,
    maxRetries: 2,
    retryDelayMs: 200,
    sleep: async (ms) => void slept.push(ms),
  });
  await e2.getJson("/x");
  assert.deepEqual(slept, [200]);
});

test("without Retry-After the backoff stays linear", async () => {
  const slept: number[] = [];
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls < 3 ? jsonResponse({ error: "busy" }, 503) : jsonResponse(fx.landData);
  });
  const e = new RequestEngine({
    transport: mt.transport,
    maxRetries: 3,
    retryDelayMs: 200,
    sleep: async (ms) => void slept.push(ms),
  });
  await e.getJson("/x");
  assert.deepEqual(slept, [200, 400]);
});

test("requestUrl rejects a non-http(s) scheme at the engine level, before the transport", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.landData));
  // Data host with a file: base URL — a library consumer injecting a custom
  // transport would otherwise never hit a scheme check.
  // A file: base URL is refused when the engine is built.
  assert.throws(
    () => new RequestEngine({ transport: mt.transport, baseUrl: "file:///etc/passwd" }),
    RegionalatlasValidationError,
  );
  // Absolute (catalogue) URL with an ftp: scheme.
  const e2 = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e2.getJsonAbsolute("ftp://cat.test/services.json"),
    RegionalatlasNetworkError,
  );
  // The transport was never invoked in either case.
  assert.equal(mt.calls.length, 0);
});

test("sanitizeServerText drops bidi controls and folds line breaks to one line", () => {
  assert.equal(sanitizeServerText("a‮b⁦c‏d"), "abcd");
  assert.equal(sanitizeServerText("  one\nError: forged\r\n\ttwo three  "), "one Error: forged two three");
});

test("a malformed Retry-After falls back to linear backoff instead of a zero-delay burst", async () => {
  for (const header of ["1.5", "-5", "0.5", "10 x", "+5", "1e3", "0x10", "2026-09-26T10:00:00Z"]) {
    const slept: number[] = [];
    let calls = 0;
    const mt = makeMockTransport(() => {
      calls += 1;
      return calls < 3
        ? rawResponse("slow down", "text/plain", 429, { "retry-after": header })
        : jsonResponse(fx.landData);
    });
    const e = new RequestEngine({
      transport: mt.transport,
      maxRetries: 5,
      retryDelayMs: 200,
      sleep: async (ms) => void slept.push(ms),
    });
    await e.getJson("/x");
    assert.deepEqual(slept, [200, 400], header);
  }
});

test("parseRetryAfter reads delta-seconds and an IMF-fixdate only", () => {
  const now = Date.parse("Sat, 26 Sep 2026 10:00:00 GMT");
  assert.equal(parseRetryAfter("7", now), 7000);
  assert.equal(parseRetryAfter([" 2 ", "9"], now), 2000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 10:00:03 GMT", now), 3000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 09:00:00 GMT", now), 0);
  for (const bad of [undefined, "", "1.5", "-5", "Saturday, 26-Sep-26 10:00:03 GMT", "Sat Sep 26 10:00:03 2026"]) {
    assert.equal(parseRetryAfter(bad, now), undefined, String(bad));
  }
});

test("the engine refuses a base URL with a query or fragment, without echoing userinfo", () => {
  assert.throws(
    () => new RequestEngine({ baseUrl: "http://u:secret@h.example/m?token=1" }),
    (err: unknown) =>
      err instanceof RegionalatlasValidationError &&
      err.message === "Invalid baseUrl: A base URL cannot have a query (?) or fragment (#).",
  );
  assert.throws(() => new RequestEngine({ baseUrl: "http://h.example/m#f" }), RegionalatlasValidationError);
  assert.doesNotThrow(() => new RequestEngine({ baseUrl: "http://h.example/mirror/" }));
});

test("negative, fractional, NaN or oversized engine options are refused", () => {
  for (const [name, value] of [
    ["maxResponseBytes", -5],
    ["timeoutMs", -1],
    ["timeoutMs", Number.NaN],
    ["timeoutMs", 2 ** 31],
    ["maxRetries", -3],
    ["maxRetries", 11],
    ["maxRetries", Number.POSITIVE_INFINITY],
    ["retryDelayMs", 1.5],
    ["retryDelayMs", 30_001],
  ] as const) {
    assert.throws(
      () => new RequestEngine({ [name]: value }),
      (err: unknown) =>
        err instanceof RegionalatlasValidationError &&
        err.message.startsWith(`Invalid option ${name}: expected an integer from 0 to `) &&
        err.message.endsWith(`, got ${String(value)}.`),
      `${name}=${value}`,
    );
  }
  assert.doesNotThrow(
    () => new RequestEngine({ timeoutMs: 0, maxRetries: 10, retryDelayMs: 0, maxResponseBytes: 0 }),
  );
});

test("the constructor refuses an unsendable userAgent or defaultHeaders entry before any request", () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const bad: EngineOptions[] = [
    { userAgent: "" },
    { userAgent: "a\r\nb" },
    { userAgent: "€" },
    { defaultHeaders: { "X-A": "v\r\nX-Injected: 1" } },
    { defaultHeaders: { "X-A": "" } },
    { defaultHeaders: { "Bad Name": "v" } },
    { defaultHeaders: { "X-A\r\nX-B": "v" } },
  ];
  for (const options of bad) {
    assert.throws(
      () => new RequestEngine({ ...options, transport: mt.transport }),
      RegionalatlasValidationError,
      JSON.stringify(options),
    );
  }
  assert.equal(mt.calls.length, 0);
  assert.doesNotThrow(() => new RequestEngine({ userAgent: "é\tagent", defaultHeaders: { "X-Trace": "1" } }));
  assert.equal(assertHeaderValue("userAgent", "ok"), "ok");
  assert.throws(() => assertHeaderValue("userAgent", " "), /^RegionalatlasValidationError: Invalid userAgent: Expected a non-empty value\.$/);
});

test("a JSON body is decoded by its declared charset; a BOM is dropped; an unknown charset is a parse error", async () => {
  const text = '{"name":"Baden-Württemberg"}';
  const cases: Array<[Buffer, string]> = [
    [Buffer.from(text, "latin1"), "application/json; charset=ISO-8859-1"],
    [Buffer.from(text, "utf8"), "application/json; charset=utf-8"],
    [Buffer.from(text, "utf8"), "application/json"],
    [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]), "application/json"],
  ];
  for (const [body, contentType] of cases) {
    const mt = makeMockTransport(() => rawResponse(body, contentType));
    const e = new RequestEngine({ transport: mt.transport });
    assert.deepEqual(await e.getJson("/q"), { name: "Baden-Württemberg" }, contentType);
  }
  const mt = makeMockTransport(() => rawResponse(text, "application/json; charset=x-klingon"));
  await assert.rejects(new RequestEngine({ transport: mt.transport }).getJson("/q"), RegionalatlasParseError);
});

test("the error after the retries ran out says how many were made", async () => {
  const sleep = async (): Promise<void> => {};
  // A 429/503 that persists: "(retried n times)", and `retries` on the error.
  for (const [maxRetries, suffix] of [[2, " (retried 2 times)"], [1, " (retried 1 time)"], [0, ""]] as const) {
    const mt = makeMockTransport(() => jsonResponse({ error: { message: "busy" } }, 503));
    const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport, maxRetries, sleep });
    await assert.rejects(
      () => e.getJson("/x"),
      (err) => err instanceof RegionalatlasApiError && err.message.endsWith(`busy${suffix}`) && err.retries === maxRetries,
    );
  }
  // A reset connection that persists says so too.
  const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const e = new RequestEngine({ baseUrl: "https://example.test", transport: async () => { throw reset; }, maxRetries: 3, sleep });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof RegionalatlasNetworkError && err.message === "socket hang up (retried 3 times)",
  );
  // Statuses and failures that are never retried carry no suffix.
  const notFound = new RequestEngine({ baseUrl: "https://example.test", transport: async () => jsonResponse({ message: "no" }, 404), maxRetries: 3, sleep });
  await assert.rejects(() => notFound.getJson("/x"), (err) => err instanceof RegionalatlasApiError && !/retried/.test(err.message) && err.retries === 0);
  const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const down = new RequestEngine({ baseUrl: "https://example.test", transport: async () => { throw refused; }, maxRetries: 3, sleep });
  await assert.rejects(() => down.getJson("/x"), (err) => err instanceof RegionalatlasNetworkError && !/retried/.test(err.message));
});

test("cutText never cuts inside a surrogate pair; toWellFormed replaces half a character", () => {
  assert.equal(cutText("ab\u{1f600}cd", 3), "ab");
  assert.equal(cutText("ab\u{1f600}cd", 4), "ab\u{1f600}");
  assert.equal(cutText("short", 10), "short");
  assert.equal(toWellFormed("a\ud83d b\ude00 \u{1f600}"), "a\ufffd b\ufffd \u{1f600}");
});

test("a server text cut at 500 or 200 characters keeps the message well-formed", async () => {
  const text = "a" + "\u{1f600}".repeat(400);
  for (const response of [
    jsonResponse({ message: text }, 500),
    jsonResponse({ error: { code: 500, message: text } }, 500),
    rawResponse(text, "text/plain", 500),
  ]) {
    const e = new RequestEngine({ transport: makeMockTransport(() => response).transport, maxRetries: 0 });
    await assert.rejects(e.getJson("/x/query"), (err: Error) => {
      assert.ok(err instanceof RegionalatlasApiError);
      assert.equal(toWellFormed(err.message), err.message);
      assert.match(err.message, /…$/);
      return true;
    });
  }
});

test("credentials a server echoes are scrubbed from the error: Basic, user:password, password (L13)", async () => {
  const basic = Buffer.from("alice:pa ss-pw", "utf8").toString("base64");
  const echo = `no: Basic ${basic} / alice:pa ss-pw / pa ss-pw`;
  const check = (err: unknown): boolean => {
    assert.ok(err instanceof RegionalatlasApiError);
    for (const form of [basic, "alice:pa ss-pw", "pa ss-pw"]) {
      assert.ok(!err.message.includes(form), err.message);
      assert.ok(!err.body.includes(form), err.body);
    }
    assert.match(err.message, /no: Basic \*\*\* \/ \*\*\* \/ \*\*\*/);
    return true;
  };
  // An HTTP error from the data host.
  const e = new RequestEngine({ baseUrl: "https://alice:pa%20ss-pw@mirror.example", transport: makeMockTransport(() => jsonResponse({ message: echo }, 401)).transport, maxRetries: 0 });
  await assert.rejects(e.getJson("/x/query"), check);
  // The ArcGIS envelope with HTTP 200, read by the client.
  const client = new RegionalatlasClient({
    baseUrl: "https://alice:pa%20ss-pw@mirror.example",
    transport: makeMockTransport((req) => jsonResponse(new URL(req.url).hostname.includes("statistikportal") ? fx.catalog : { error: { code: 498, message: echo } })).transport,
  });
  await assert.rejects(client.query({ indicator: "AI002-1-5", year: 2020 }), check);
});
