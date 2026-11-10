import { test } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  RequestEngine,
  assertHeaderValue,
  cleanServerText,
  describeArcGisError,
  parseRetryAfter,
  sanitizeServerText,
  type EngineOptions,
  bigIntegerKeysOption,
  scanNumbers,
} from "../src/engine.js";
import {
  RegionalatlasApiError,
  RegionalatlasNetworkError,
  RegionalatlasParseError,
  RegionalatlasSizeLimitError,
  RegionalatlasValidationError,
  TextBuilder,
  cutText,
  redactUrlUserinfo,
  toWellFormed,
} from "../src/errors.js";
import { RegionalatlasClient } from "../src/client.js";
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

test("getJson refuses an empty body, a 204 too: both hosts always answer with JSON", async () => {
  for (const status of [200, 204]) {
    const mt = makeMockTransport(() => rawResponse("", "application/json", status));
    const e = new RequestEngine({ transport: mt.transport });
    await assert.rejects(e.getJson("/x"), (err: Error) => err instanceof RegionalatlasParseError && err.message === "GET https://www.gis-idmz.nrw.de/x: empty response body.");
  }
});

test("getJson throws RegionalatlasParseError on invalid JSON", async () => {
  const mt = makeMockTransport(() => rawResponse("not json", "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson("/x"), RegionalatlasParseError);
});

test("a number the JSON cannot carry exactly is a parse error, never a changed value", async () => {
  // JSON.parse rounds 12345678901234567890 (in any form: .0, e0, E-1) and 9007199254740992.5 to the
  // nearest double, turns 1e400 into Infinity (printed as null) and 1e-400 into 0, silently.
  const body = (n: string) => `{"features":[{"attributes":{"ags":"01","ai0201":${n},"gen":"12345678901234567890 in a string"}}]}`;
  for (const n of [
    "12345678901234567890", "-9007199254740993", "1e400", "-1E400", "12345678901234567890.0", "9007199254740993e0",
    "90071992547409930E-1", "9007199254740992.5", "-9007199254740992.5", "1e-400", "-0.0001e-399",
    "123456789012345678901234567890",
    // Subnormal: a double has fewer digits below 2.2250738585072014e-308, so these print as
    // another number (3e-324 as 5e-324) (D4).
    "3e-324", "4e-324", "-4.9e-324", "1.2345678901234567e-310", "2.225073858507201e-309",
  ]) {
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(body(n), "application/json")).transport });
    await assert.rejects(e.getJson("/x/query"), (err: unknown) => {
      assert.ok(err instanceof RegionalatlasParseError, n);
      assert.equal(err.message, `GET https://www.gis-idmz.nrw.de/x/query: the number ${n} cannot be represented exactly.`);
      return true;
    });
  }
  // What a double carries exactly, or as JSON means it (a decimal fraction below 2^53), passes.
  const exact: Array<[string, number]> = [
    ["9007199254740991", 9007199254740991], ["9007199254740992.0", 2 ** 53], ["9007199254740992e0", 2 ** 53],
    ["90071992547409920E-1", 2 ** 53], ["1e21", 1e21], ["1.2e21", 1.2e21], ["0", 0], ["-0", -0], ["0.0e-500", 0],
    ["1.10", 1.1], ["0.1", 0.1], ["1.00000000000000001", 1], ["5e-324", 5e-324], ["2222222222", 2222222222],
    // A subnormal printed as written, and the smallest normal double (D4).
    ["-5e-324", -5e-324], ["1e-310", 1e-310], ["2.2250738585072014e-308", 2.2250738585072014e-308],
    // A double a server printed in its shortest form reads back as that double and prints as the
    // same number: not a changed value, though the decimal is not the double's exact binary value.
    // ArcGIS writes such sentinels (1.7976931348623157E308, the largest double).
    ["1e23", 1e23], ["100000000000000000000000", 1e23], ["1E23", 1e23], ["1.7976931348623157E308", Number.MAX_VALUE], ["-1.7976931348623157e308", -Number.MAX_VALUE],
    ["4.35e30", 4.35e30],
  ];
  type Body = { features: Array<{ attributes: { ai0201: number } }> };
  for (const [n, value] of exact) {
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(body(n), "application/json")).transport });
    assert.equal((await e.getJson<Body>("/x/query")).features[0]?.attributes.ai0201, value, n);
  }
});

test("the catalogue is checked for inexact numbers too, named by its redacted URL", async () => {
  const mt = makeMockTransport(() => rawResponse(`[{"title":"T","n":1e400,"children":[]}]`, "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(e.getJsonAbsolute("https://u:secret@cat.test/services.json"), (err: unknown) => {
    assert.ok(err instanceof RegionalatlasParseError);
    assert.equal(err.message, "GET https://***@cat.test/services.json: the number 1e400 cannot be represented exactly.");
    return true;
  });
});

test("the number check skips strings and costs one pass over the text", async () => {
  // Escaped quotes and backslashes must not end a string early and expose its digits.
  const tricky = `{"id":"a","s":"\\\\\\"12345678901234567890\\\\","t":"1e400","n":[1,2.5,-3e2]}`;
  const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(tricky, "application/json")).transport });
  assert.deepEqual(await e.getJson("/x"), JSON.parse(tricky));
  // 1 MB of numbers: the scan is linear.
  const big = `[${Array.from({ length: 200_000 }, (_, i) => i * 7).join(",")}]`;
  const f = new RequestEngine({ transport: makeMockTransport(() => rawResponse(big, "application/json")).transport });
  assert.equal((await f.getJson<number[]>("/x")).length, 200_000);
});

test("a number with a long run of zeros is refused in linear time (security audit 2026-10-27, A)", async () => {
  // 1.<100 000 zeros>1e300 took about 15 s with the trailing-zero regex `/0+$/`; the linear check
  // takes milliseconds. A value of 0 (1<zeros>1e-9999999) reaches the same check.
  for (const n of [`1.${"0".repeat(100_000)}1e300`, `1${"0".repeat(100_000)}1e-9999999`]) {
    const body = `{"features":[{"attributes":{"ags":"01","ai0201":${n}}}]}`;
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(body, "application/json")).transport });
    const started = performance.now();
    await assert.rejects(e.getJson("/x/query"), (err: unknown) => {
      assert.ok(err instanceof RegionalatlasParseError && /cannot be represented exactly/.test(err.message), String(err));
      assert.ok(err.message.length < 1000, "the message quotes the literal cut");
      return true;
    });
    const ms = performance.now() - started;
    assert.ok(ms < 1000, `${Math.round(ms)} ms`);
  }
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
      // Whole escape sequences go, not only their control bytes (`ESC[31m`, the 8-bit CSI `2J`).
      assert.equal(err.detail, "boomred");
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
    (err) => err instanceof RegionalatlasNetworkError && err.message === "GET https://example.test/x failed: socket hang up (retried 3 times)",
  );
  // Statuses and failures that are never retried carry no suffix.
  const notFound = new RequestEngine({ baseUrl: "https://example.test", transport: async () => jsonResponse({ message: "no" }, 404), maxRetries: 3, sleep });
  await assert.rejects(() => notFound.getJson("/x"), (err) => err instanceof RegionalatlasApiError && !/retried/.test(err.message) && err.retries === 0);
  const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const down = new RequestEngine({ baseUrl: "https://example.test", transport: async () => { throw refused; }, maxRetries: 3, sleep });
  await assert.rejects(() => down.getJson("/x"), (err) => err instanceof RegionalatlasNetworkError && !/retried/.test(err.message));
});

test("a network failure names the request, userinfo and token redacted, with the original as the cause", async () => {
  const sleep = async (): Promise<void> => {};
  const base = "https://user:secret@example.test";
  const failing = (cause: unknown) => async (): Promise<never> => {
    throw cause;
  };
  const cases: Array<[string, unknown, string]> = [
    ["a timeout", new RegionalatlasNetworkError("Request timed out after 300ms"), "Request timed out after 300ms"],
    ["a refused connection", Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }), "connect ECONNREFUSED 127.0.0.1:1"],
    ["a DNS failure", Object.assign(new Error("getaddrinfo ENOTFOUND example.invalid"), { code: "ENOTFOUND" }), "getaddrinfo ENOTFOUND example.invalid"],
    ["the transport's size cap", new RegionalatlasSizeLimitError(10), "Response exceeded the size limit of 10 bytes (maxResponseBytes; --max-response-bytes on the CLI)"],
  ];
  for (const [what, cause, reason] of cases) {
    const e = new RequestEngine({ baseUrl: base, transport: failing(cause), maxRetries: 0, sleep });
    await assert.rejects(e.getJson("/x/query", { f: "json" }), (err: unknown) => {
      assert.ok(err instanceof RegionalatlasNetworkError, what);
      assert.equal(err.message, `GET https://***@example.test/x/query?f=json failed: ${reason}`, what);
      assert.equal(err.cause, cause, what);
      return true;
    });
  }
  // The engine's own deadline and size cap, and the catalogue (a token redacted, the download named).
  const slow = new RequestEngine({ baseUrl: base, transport: () => new Promise(() => {}), timeoutMs: 20, maxRetries: 0 });
  await assert.rejects(slow.getJson("/x"), (err: unknown) => {
    assert.ok(err instanceof RegionalatlasNetworkError);
    assert.equal(err.message, "GET https://***@example.test/x failed: Request exceeded the 20ms deadline");
    return true;
  });
  const big = new RequestEngine({ transport: async () => jsonResponse({ padding: "x".repeat(100) }), maxResponseBytes: 50 });
  await assert.rejects(big.getJsonAbsolute("https://cat.test/services.json?token=abcdefgh"), (err: unknown) => {
    assert.ok(err instanceof RegionalatlasSizeLimitError);
    assert.equal(err.download, "catalogue");
    assert.equal(
      err.message,
      "GET https://cat.test/services.json?token=*** failed: The indicator catalogue exceeded the size limit of 50 bytes (maxResponseBytes; --max-response-bytes on the CLI)",
    );
    return true;
  });
  const capped = new RequestEngine({ transport: failing(new RegionalatlasSizeLimitError(50)), maxRetries: 0 });
  await assert.rejects(capped.getJson("/x"), (err: unknown) => {
    assert.ok(err instanceof RegionalatlasSizeLimitError);
    assert.equal(err.download, "data");
    assert.equal(err.limit, 50);
    assert.match(err.message, /^GET https:\/\/www\.gis-idmz\.nrw\.de\/x failed: Response exceeded the size limit of 50 bytes/);
    return true;
  });
  // A real refused connection through the default transport (a closed port on loopback).
  const refused = new RequestEngine({ baseUrl: "http://127.0.0.1:1", maxRetries: 0 });
  await assert.rejects(refused.getJson("/x"), (err: unknown) => {
    assert.ok(err instanceof RegionalatlasNetworkError);
    assert.match(err.message, /^GET http:\/\/127\.0\.0\.1:1\/x failed: connect ECONNREFUSED/);
    return true;
  });
  // The long `layer` parameter is shortened, as in an HTTP error.
  const long = new RequestEngine({ transport: failing(new Error("boom")), maxRetries: 0 });
  await assert.rejects(long.getJson("/x", { layer: "y".repeat(500) }), (err: unknown) => {
    assert.ok(err instanceof RegionalatlasNetworkError);
    assert.equal(err.message, "GET https://www.gis-idmz.nrw.de/x?layer=… failed: boom");
    return true;
  });
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

test("onRetry is called once per retry, with the event fields, right before the sleep", async () => {
  const log: string[] = [];
  const events: unknown[] = [];
  let n = 0;
  const mt = makeMockTransport(() =>
    n++ < 2
      ? { status: 503, headers: n === 1 ? { "retry-after": "2" } : {}, body: Buffer.from("{}") }
      : jsonResponse({ ok: 1 }),
  );
  const e = new RequestEngine({
    transport: mt.transport,
    baseUrl: "https://user:pw@example.test",
    maxRetries: 3,
    sleep: async (ms) => void log.push(`sleep ${ms}`),
    onRetry: (ev) => {
      events.push(ev);
      log.push("retry");
    },
  });
  await e.getJson("/x");
  assert.deepEqual(log, ["retry", "sleep 2000", "retry", "sleep 400"]);
  assert.equal(events.length, 2);
  for (const [i, ev] of events.entries()) {
    const { url, ...rest } = ev as { url: string };
    assert.deepEqual(rest, i === 0 ? { retry: 1, maxRetries: 3, delayMs: 2000, status: 503 } : { retry: 2, maxRetries: 3, delayMs: 400, status: 503 });
    assert.ok(url.endsWith("example.test/x") && !url.includes("pw"), url);
  }
});

test("onRetry reports a reset connection without a status", async () => {
  let n = 0;
  const events: unknown[] = [];
  const mt = makeMockTransport(() => {
    if (n++ === 0) throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    return jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {}, onRetry: (ev) => void events.push(ev) });
  await e.getJson("/x");
  assert.equal(events.length, 1);
  assert.equal((events[0] as { status?: number }).status, undefined);
  assert.equal((events[0] as { retry: number }).retry, 1);
});

test("onRetry is never called without a retry", async () => {
  const events: unknown[] = [];
  const onRetry = (ev: unknown) => void events.push(ev);
  const ok = new RequestEngine({ transport: makeMockTransport(() => jsonResponse({})).transport, sleep: async () => {}, onRetry });
  await ok.getJson("/x");
  const notFound = new RequestEngine({
    transport: makeMockTransport(() => jsonResponse({ detail: "no" }, 404)).transport,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(notFound.getJson("/x"), RegionalatlasApiError);
  // retries exhausted: the last 503 is an error, not a retry
  const down = new RequestEngine({
    transport: makeMockTransport(() => ({ status: 503, headers: {}, body: Buffer.from("{}") })).transport,
    maxRetries: 1,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(down.getJson("/x"), RegionalatlasApiError);
  assert.equal(events.length, 1);
});

test("a throw in onRetry is swallowed", async () => {
  let n = 0;
  const e = new RequestEngine({
    transport: makeMockTransport(() => (n++ === 0 ? { status: 503, headers: {}, body: Buffer.from("{}") } : jsonResponse({}))).transport,
    sleep: async () => {},
    onRetry: () => {
      throw new Error("boom");
    },
  });
  await e.getJson("/x");
});

test("onRetry must be a function", () => {
  assert.throws(() => new RequestEngine({ onRetry: 5 as never }), RegionalatlasValidationError);
  assert.throws(() => new RegionalatlasClient({ onRetry: 5 as never }), RegionalatlasValidationError);
});

test("a header named __proto__ is an ordinary header, never the prototype of the headers read (T12)", async () => {
  // A JavaScript transport may return any object; JSON.parse makes "__proto__" an own key.
  const headers = JSON.parse('{"__proto__":{"content-type":"application/json; charset=bogus"}}') as Record<string, string>;
  const e = new RequestEngine({ transport: async () => ({ status: 200, headers, body: Buffer.from('{"a":1}') }) });
  // With the prototype set, its charset was read as the Content-Type's and refused.
  assert.deepEqual(await e.getJson("/x"), { a: 1 });
  const fetchLike = new Headers([["__proto__", "x"], ["content-type", "application/json"]]);
  const f = new RequestEngine({ transport: async () => ({ status: 200, headers: fetchLike as unknown as Record<string, string>, body: Buffer.from('{"a":1}') }) });
  assert.deepEqual(await f.getJson("/x"), { a: 1 });
});

test("bigIntegerKeys: a declared member's number is its exact literal as a string; others keep the rule (D3)", async () => {
  const body = '{"_version_":1858054135406919680,"small":{"_version_":5},"neg":{"\\u005fversion_":-12345678901234567890},' +
    '"s":{"_version_":"text"},"n":{"_version_":null},"arr":{"_version_":[1]},"t":"\\"_version_\\":1","n2":42}';
  const e = new RequestEngine({
    bigIntegerKeys: new Set(["_version_"]),
    transport: makeMockTransport(() => rawResponse(body, "application/json")).transport,
  });
  assert.deepEqual(await e.getJson("/x"), {
    _version_: "1858054135406919680", small: { _version_: "5" }, neg: { _version_: "-12345678901234567890" },
    s: { _version_: "text" }, n: { _version_: null }, arr: { _version_: [1] }, t: '"_version_":1', n2: 42,
  });
  assert.deepEqual([...e.bigIntegerKeys], ["_version_"]);
  // An undeclared big number is still refused; a declared member doesn't make others exact.
  const other = new RequestEngine({
    bigIntegerKeys: ["_version_"] as unknown as ReadonlySet<string>,
    transport: makeMockTransport(() => rawResponse('{"_version_":1858054135406919680,"id":12345678901234567890}', "application/json")).transport,
  });
  await assert.rejects(other.getJson("/x"), /the number 12345678901234567890 cannot be represented exactly/);
  // Malformed stays malformed: a declared member with a leading zero still fails JSON.parse.
  const malformed = new RequestEngine({ bigIntegerKeys: new Set(["_version_"]), transport: makeMockTransport(() => rawResponse('{"_version_":01}', "application/json")).transport });
  await assert.rejects(malformed.getJson("/x"), RegionalatlasParseError);
  for (const bad of [new Set([""]), new Set([1]), "x", 5, null]) {
    assert.throws(() => new RequestEngine({ bigIntegerKeys: bad as unknown as ReadonlySet<string> }),
      (err: unknown) => err instanceof RegionalatlasValidationError && err.message === "Invalid option bigIntegerKeys: expected a set of non-empty member names.");
  }
  // The option reader copies a set or a list; undefined is none.
  const names = new Set(["a"]);
  const copy = bigIntegerKeysOption(names);
  names.add("b");
  assert.deepEqual([...copy], ["a"]);
  assert.deepEqual([...bigIntegerKeysOption(["x", "y"] as unknown as ReadonlySet<string>)], ["x", "y"]);
  assert.equal(bigIntegerKeysOption(undefined).size, 0);
  // The client takes the option too (it declares none of its own).
  assert.deepEqual(await new RegionalatlasClient({ bigIntegerKeys: new Set(["x"]), transport: makeMockTransport(() => jsonResponse([])).transport }).themes(), []);
  // Without declarations the scan is the plain number check.
  assert.deepEqual(scanNumbers('{"a":"1e400","b":3e-324}'), { json: '{"a":"1e400","b":3e-324}', inexact: "3e-324" });
  assert.deepEqual(scanNumbers('{"a":1}'), { json: '{"a":1}', inexact: undefined });
});

test("an answer error names the request: method and URL, userinfo and token redacted (D9)", async () => {
  const answer = (body: string, type = "application/json") => makeMockTransport(() => rawResponse(body, type)).transport;
  const data = (transport: ReturnType<typeof answer>) => new RequestEngine({ baseUrl: "https://u:pw@data.test", transport });
  const cases: Array<[ReturnType<typeof answer>, string]> = [
    [answer("<html>maintenance</html>", "text/html"), 'GET https://***@data.test/x/query?a=1: the answer is not valid JSON (expected JSON, got Content-Type "text/html").'],
    [answer("{"), "GET https://***@data.test/x/query?a=1: the answer is not valid JSON."],
    [answer(""), "GET https://***@data.test/x/query?a=1: empty response body."],
    [answer(" \n"), "GET https://***@data.test/x/query?a=1: empty response body."],
    [answer("{}", "application/json; charset=x-bogus"), 'GET https://***@data.test/x/query?a=1: unsupported response charset "x-bogus".'],
    [answer('{"n":1e400}'), "GET https://***@data.test/x/query?a=1: the number 1e400 cannot be represented exactly."],
  ];
  for (const [transport, message] of cases) {
    await assert.rejects(data(transport).getJson("/x/query", { a: 1 }), (err: unknown) => {
      assert.ok(err instanceof RegionalatlasParseError, String(err));
      assert.equal(err.message, message);
      return true;
    });
  }
  // The catalogue: the absolute URL, its token redacted.
  const e = new RequestEngine({ transport: answer("<html>", "text/html") });
  await assert.rejects(e.getJsonAbsolute("https://u:pw@cat.test/services.json?token=s3cr3tvalue"), (err: Error) =>
    err.message === 'GET https://***@cat.test/services.json?token=***: the answer is not valid JSON (expected JSON, got Content-Type "text/html").');
  // The client's own answer errors too: a wrong shape, a refused catalogue.
  const c = new RegionalatlasClient({
    baseUrl: "https://u:pw@data.test",
    catalogUrl: "https://cat.test/services.json?token=s3cr3tvalue",
    transport: makeMockTransport((req) => (req.url.includes("cat.test") ? jsonResponse(fx.catalog) : jsonResponse({ status: "maintenance" }))).transport,
  });
  await assert.rejects(c.query({ indicator: "AI002-1-5", year: 2020 }), (err: Error) =>
    err instanceof RegionalatlasParseError && /^GET https:\/\/\*\*\*@data\.test\/arcgis\/\S+: unexpected response shape: expected a features array, got none\.$/.test(err.message));
  const refused = new RegionalatlasClient({ catalogUrl: "https://cat.test/services.json?token=s3cr3tvalue", transport: answer('{"themes":[]}') });
  await assert.rejects(refused.themes(), (err: Error) =>
    err.message === "GET https://cat.test/services.json?token=***: unexpected catalogue shape: expected a JSON array of themes.");
  await assert.rejects(refused.indicators(), (err: Error) => err.message.startsWith("GET https://cat.test/services.json?token=***: "));
});

test("text that is not valid is replaced with U+FFFD and reported through onWarning, never silently (D2)", async () => {
  const cases: Array<[string, Buffer, string, unknown, number]> = [
    // A lone surrogate written as an escape (high alone, low alone); a real pair and an escaped backslash stay.
    ["lone escapes", Buffer.from('{"a":"x\\ud800y","b":"\\udc00","c":"\\ud83d\\ude00","d":"\\\\ud800"}'), "application/json", { a: "x\ufffdy", b: "\ufffd", c: "\u{1f600}", d: "\\ud800" }, 2],
    // A lone surrogate in a member name.
    ["lone in a key", Buffer.from('{"\\udbff":1}'), "application/json", { "\ufffd": 1 }, 1],
    // Invalid UTF-8 bytes; a U+FFFD the server sent is not counted.
    ["invalid bytes", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xc3]), Buffer.from('","b":"\ufffd"}')]), "application/json", { a: "\ufffd\ufffd", b: "\ufffd" }, 2],
    // A byte undefined in a single-byte charset.
    ["iso-8859-3", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xa5]), Buffer.from('"}')]), "application/json; charset=iso-8859-3", { a: "\ufffd" }, 1],
  ];
  for (const [label, body, type, expected, count] of cases) {
    const warnings: string[] = [];
    const e = new RequestEngine({ onWarning: (m) => warnings.push(m), transport: makeMockTransport(() => rawResponse(body, type)).transport });
    const value = await e.getJson("/items", { q: "x" });
    assert.deepEqual(value, expected, label);
    assert.ok(!/[\ud800-\udfff]/u.test(JSON.stringify(value)), `${label}: well-formed`);
    assert.deepEqual(warnings, [
      `GET https://www.gis-idmz.nrw.de/items?q=x: ${count} ${count === 1 ? "character" : "characters"} of the answer ${count === 1 ? "was" : "were"} not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.`,
    ], label);
  }
  // Valid text: no warning; a throwing hook never fails the request.
  const quiet: string[] = [];
  const ok = new RequestEngine({ onWarning: (m) => quiet.push(m), transport: makeMockTransport(() => rawResponse('{"a":"\\u00fc\ufffd"}', "application/json")).transport });
  assert.deepEqual(await ok.getJson("/x"), { a: "ü\ufffd" });
  assert.deepEqual(quiet, []);
  const throwing = new RequestEngine({ onWarning: () => { throw new Error("hook"); }, transport: makeMockTransport(() => rawResponse('"\\ud800"', "application/json")).transport });
  assert.equal(await throwing.getJson("/x"), "\ufffd");
  assert.throws(() => new RequestEngine({ onWarning: "log" as unknown as () => void }), RegionalatlasValidationError);
});

test("an answer longer than V8's longest string is a RegionalatlasParseError naming the request, not a plain Error (T14)", async (t) => {
  // A real one needs a body of 512 MB and more (possible with maxResponseBytes 0): V8's own
  // error is stood in for, for the body marked by its length.
  const huge = Buffer.from('{"features":[]}       ');
  const tooLong = Object.assign(new Error("Cannot create a string longer than 0x1fffffe8 characters"), { code: "ERR_STRING_TOO_LONG" });
  const { TextDecoder } = await import("node:util");
  const decode = TextDecoder.prototype.decode;
  t.mock.method(TextDecoder.prototype, "decode", function (this: InstanceType<typeof TextDecoder>, input?: Uint8Array, options?: { stream?: boolean }) {
    if (input !== undefined && input.byteLength === huge.length) throw tooLong;
    return decode.call(this, input, options);
  });
  const toString = Buffer.prototype.toString;
  t.mock.method(Buffer.prototype, "toString", function (this: Buffer, ...args: Parameters<Buffer["toString"]>) {
    if (this.length === huge.length && args[0] === "utf8") throw tooLong;
    return toString.apply(this, args);
  });
  const e = new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(huge, "application/json")).transport });
  await assert.rejects(e.getJson("/x/query", { f: "json" }), (err: unknown) => {
    assert.ok(err instanceof RegionalatlasParseError, String(err));
    assert.equal(
      err.message,
      `GET https://www.gis-idmz.nrw.de/x/query?f=json: the answer is too large to read as text (${huge.length} bytes; the longest string is 536870888 characters).`,
    );
    return true;
  });
  // An error status with such a body is still the API error, without the unreadable body.
  const failing = new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(huge, "text/plain", 500)).transport });
  await assert.rejects(failing.getJson("/x"), (err: unknown) => err instanceof RegionalatlasApiError && err.status === 500 && err.body === "");
});

test("redactUrlUserinfo hides every URL's userinfo in one linear pass, however many URLs (security audit 2026-10-27, B)", () => {
  // The URL regex this replaces (a scheme tried at every word start) took about 3 s on this.
  const elapsed = (fn: () => unknown): number => {
    const started = performance.now();
    fn();
    return performance.now() - started;
  };
  assert.ok(elapsed(() => redactUrlUserinfo("a.".repeat(30_000))) < 1000);
  assert.equal(redactUrlUserinfo("a -https://u:p@h/x and x-ftp://v@w?q, mail@example.org"), "a -https://***@h/x and x-ftp://***@w?q, mail@example.org");
  assert.equal(redactUrlUserinfo("1://u:p@h ://u:p@h"), "1://u:p@h ://u:p@h");
  assert.equal(redactUrlUserinfo("https://h/p?u=a@b"), "https://h/p?u=a@b");
  assert.equal(redactUrlUserinfo("HTTPS://u:p@h https://a@b@c/x 'https://u:p@h'"), "HTTPS://***@h https://***@c/x 'https://***@h'");
  // A URL glued to the authority before it (its scheme inside that authority) is still found,
  // as the regex found it.
  assert.equal(redactUrlUserinfo("https://u:p@x://v:q@w"), "https://***@x://***@w");
  assert.equal(redactUrlUserinfo("https://host://u:p@h"), "https://host://***@h");
  for (const text of ["a".repeat(1_000_000), "a.".repeat(500_000), "://".repeat(100_000), ":/".repeat(100_000), `https://${"u".repeat(1_000_000)}`]) {
    assert.equal(redactUrlUserinfo(text), text);
  }
  assert.equal(redactUrlUserinfo("https://u:p@h ".repeat(100_000)), "https://***@h ".repeat(100_000));
  assert.equal(redactUrlUserinfo("a://u@".repeat(100_000)), "a://***@".repeat(100_000));
});

test("sanitizeServerText drops whole escape sequences, not just their control bytes", () => {
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const CSI8 = String.fromCharCode(0x9b);
  const OSC8 = String.fromCharCode(0x9d);
  const ST8 = String.fromCharCode(0x9c);
  for (const [input, expected] of [
    [`line1 ${ESC}]0;title${BEL}rest`, "line1 rest"],
    [`${ESC}]8;;https://evil.example${ESC}\\click${ESC}]8;;${ESC}\\`, "click"],
    [`${ESC}[31mred${ESC}[0m plain`, "red plain"],
    [`${ESC}[1;31;4mbold`, "bold"],
    [`${CSI8}2Jcleared`, "cleared"],
    [`${OSC8}0;t${ST8}ok`, "ok"],
    [`a${ESC}7b${ESC}(Bc`, "abc"],
    // Unterminated: only ESC and its introducer go, the text stays.
    [`keep ${ESC}]0;no terminator here`, "keep 0;no terminator here"],
  ] as const) {
    assert.equal(sanitizeServerText(input), expected, JSON.stringify(input));
  }
});

test("sanitizeServerText drops invisible format characters (zero-width, soft hyphen, BOM)", () => {
  const text = "real\u200b error\u2028Error: forged\u2066x\u2069 \ufeffend\u00ad\u200d\u2060!";
  assert.equal(sanitizeServerText(text), "real error Error: forgedx end!");
});

test("sanitizeServerText reads a bounded prefix and drops what the per-character filter dropped", () => {
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  // The filter it replaces, one character at a time: C0 but TAB to CR, DEL, C1 and Cf go.
  const perCharacter = (text: string): string =>
    [...text]
      .filter((ch) => {
        const n = ch.codePointAt(0) ?? 0;
        return (n >= 0x09 && n <= 0x0d) || !(n <= 0x1f || (n >= 0x7f && n <= 0x9f) || /\p{Cf}/u.test(ch));
      })
      .join("")
      .replace(/\s+/g, " ")
      .trim();
  const every = Array.from({ length: 0x3000 }, (_, i) => String.fromCharCode(i)).join("") + "\u{1f600}\u{e0001}\ud800x";
  for (let at = 0; at < every.length; at += 512) {
    const piece = every.slice(at, at + 512).replace(/[\u001b\u0090\u0098\u009b-\u009f]/g, "");
    assert.equal(sanitizeServerText(piece), perCharacter(piece), `from U+${at.toString(16)}`);
  }
  // At most 16 384 units of the text are read, never half a surrogate pair.
  assert.equal(sanitizeServerText("x".repeat(100_000)).length, 16_384);
  assert.equal(sanitizeServerText(`${"x".repeat(16_383)}\u{1f600}`), "x".repeat(16_383));
  // A control string ends at another introducer: the first is dropped by the filter, the second
  // string as a whole.
  const OSC8 = String.fromCharCode(0x9d);
  const ST8 = String.fromCharCode(0x9c);
  assert.equal(sanitizeServerText(`a${OSC8}0;x${OSC8}0;t${ST8}b`), "a0;xb");
  assert.equal(sanitizeServerText(`a${ESC}]0;x${ESC}]0;t${BEL}b`), "a0;xb");
  // The catalogue's texts are data on stdout: cleaned the same way, but whole.
  assert.equal(cleanServerText(` ${"x".repeat(100_000)}\u200b `), "x".repeat(100_000));
});

test("describeArcGisError reads the parts of an envelope only until the joined text is past its cut", () => {
  // A million `details` were each cleaned, kept and joined before the 500-character cut.
  let read = 0;
  const details = new Proxy(Array.from({ length: 1_000_000 }, (_, i) => `detail ${i} ${"x".repeat(40)}`), {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) read++;
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  const text = describeArcGisError({ message: "bad where", details });
  assert.ok(text !== undefined && text.startsWith("bad where; detail 0 ") && text.length > 500 && text.length < 600, text);
  assert.ok(read < 20, `${read} details read`);
  // Exactly at the cut: the same text, once cut, as joining every part first.
  assert.equal(cutText(describeArcGisError({ message: "", details: ["a".repeat(500), "b"] }) ?? "", 500), "a".repeat(500));
  assert.equal(describeArcGisError({ message: "a".repeat(497), details: ["a".repeat(497), "c"] }), `${"a".repeat(497)}; c`);
});

test("a TextBuilder joins its pieces in order across batches", () => {
  const b = new TextBuilder();
  const expected: string[] = [];
  for (let i = 0; i < 40_000; i++) {
    b.push(String(i), ",");
    expected.push(String(i), ",");
  }
  assert.equal(b.toString(), expected.join(""));
  assert.equal(new TextBuilder().toString(), "");
});

// This test starts a process with a small heap: 30 s instead of the suite's 5 s.
const STARTS_A_PROCESS = { timeout: 30_000 };

test("scanNumbers quotes millions of declared members within a small heap", STARTS_A_PROCESS, () => {
  // One `+=` per quoted member made a rope node each: 3 million of them exhausted a 128 MB heap.
  const engine = new URL("../src/engine.js", import.meta.url).href;
  const n = 3_000_000;
  const script =
    `const { scanNumbers } = await import(${JSON.stringify(engine)});` +
    `const json = "[" + '{"k":1},'.repeat(${n - 1}) + '{"k":1}]';` +
    `process.stdout.write(String(scanNumbers(json, new Set(["k"])).json.length));`;
  const out = execFileSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(out, String(n * 10 + 1));
});

test("a credential echoed with JSON escapes is scrubbed from the message, the detail and the decoded body (D)", async () => {
  // The body was scrubbed as sent and then decoded: `s3cret-pw` passed the exact-string scrub
  // and came back as `s3cret-pw` in the message and the detail.
  const pw = "s3cret-pw";
  const base = `https://alice:${pw}@mirror.example`;
  for (const body of [
    '{"message":"denied for s3cret\\u002dpw"}',
    '{"error":{"code":499,"message":"bad","details":["user alice:s3cret\\u002dpw"]}}',
    '{"detail":"\\u0073\\u0033\\u0063\\u0072\\u0065\\u0074\\u002d\\u0070\\u0077"}',
    // Scrubbed before it is cleaned: the cleaning reads 16 384 characters and folds whitespace, so
    // a password cut there would land inside the message as a prefix no exact string matches.
    `{"message":"${" ".repeat(16_380)}s3cret\\u002dpw"}`,
    `{"error":{"message":"${" ".repeat(16_380)}s3cret\\u002dpw"}}`,
  ]) {
    const e = new RequestEngine({ baseUrl: base, transport: async () => rawResponse(body, "application/json", 401) });
    const err = await e.getJson("/x").catch((caught: unknown) => caught);
    assert.ok(err instanceof RegionalatlasApiError, String(err));
    for (const text of [err.message, err.detail ?? "", JSON.stringify(JSON.parse(err.body))]) {
      assert.ok(!text.includes("s3cr"), `${body.slice(0, 40)}: ${text.slice(-80)}`);
    }
  }
});

test("an error body keeps its spelling unless a credential hides behind an escape", async () => {
  const base = "https://alice:s3cret-pw@mirror.example";
  const bodyOf = async (body: string): Promise<string> => {
    const e = new RequestEngine({ baseUrl: base, transport: async () => rawResponse(body, "application/json", 500) });
    const err = await e.getJson("/x").catch((caught: unknown) => caught);
    assert.ok(err instanceof RegionalatlasApiError, String(err));
    return err.body;
  };
  // No credential, or one spelled as sent: the body as sent (scrubbed), escapes kept.
  assert.equal(await bodyOf('{"m":"caf\\u00e9 \\"x\\""}'), '{"m":"caf\\u00e9 \\"x\\""}');
  assert.equal(await bodyOf('{"m":"pw s3cret-pw \\u00e9"}'), '{"m":"pw *** \\u00e9"}');
  // Escaped: written again decoded, scrubbed in that spelling.
  assert.equal(await bodyOf('{"m":"pw s3cret\\u002dpw \\u00e9"}'), '{"m":"pw *** é"}');
  // Not JSON: nobody decodes it, it stays as sent.
  assert.equal(await bodyOf("pw s3cret\\u002dpw"), "pw s3cret\\u002dpw");
  // Deeply nested: written again where this runtime can, else left out (probed, not assumed:
  // whether JSON.stringify recurses depends on the Node version).
  const deep = `${"[".repeat(200_000)}"s3cret\\u002dpw"${"]".repeat(200_000)}`;
  let parses = true;
  let writes = true;
  try {
    const value: unknown = JSON.parse(deep);
    try {
      JSON.stringify(value);
    } catch {
      writes = false;
    }
  } catch {
    parses = false;
  }
  if (parses) {
    const body = await bodyOf(deep);
    assert.ok(!body.includes("s3cret"), body.slice(199_990, 200_030));
    assert.equal(body === "", !writes);
  }
});

test("a value quoted from an answer is scrubbed before it is cut, so no part of a credential stays", async () => {
  const pw = "s3cret-Pw-long";
  const e = new RequestEngine({ baseUrl: `https://alice:${pw}@mirror.example` });
  for (const at of [0, 490, 495, 499]) {
    const quoted = e.quoteServerValue(`${"x".repeat(at)}${pw}${"y".repeat(600)}`);
    assert.ok(!quoted.includes("s3cret"), `${at}: ${quoted}`);
  }
  assert.equal(new RequestEngine().quoteServerValue('a"b'), '"a\\"b"');
});

test("an echo of the request URL as sent is scrubbed, a short password too", async () => {
  // Typed raw; WHATWG sends `p%22%C3%A4` in the URL, which a server echoes.
  const e = new RequestEngine({
    baseUrl: 'https://alice:p"ä@mirror.example',
    transport: async (req) => rawResponse(JSON.stringify({ message: `no access: ${new URL(req.url).href}` }), "application/json", 403),
  });
  const err = await e.getJson("/x").catch((caught: unknown) => caught);
  assert.ok(err instanceof RegionalatlasApiError, String(err));
  for (const text of [err.message, err.detail ?? "", err.body]) {
    assert.ok(!text.includes("p%22%C3%A4@") && !text.includes('p"ä@'), text);
  }
});
