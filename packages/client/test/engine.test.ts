import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RequestEngine,
  assertHeaderValue,
  parseRetryAfter,
  sanitizeServerText,
  type EngineOptions,
} from "../src/engine.js";
import {
  RegionalatlasApiError,
  RegionalatlasNetworkError,
  RegionalatlasParseError,
  RegionalatlasSizeLimitError,
  RegionalatlasValidationError,
  cutText,
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

test("a number the JSON cannot carry exactly is a parse error, never a changed value", async () => {
  // JSON.parse rounds 12345678901234567890 (in any form: .0, e0, E-1) and 9007199254740992.5 to the
  // nearest double, turns 1e400 into Infinity (printed as null) and 1e-400 into 0, silently.
  const body = (n: string) => `{"features":[{"attributes":{"ags":"01","ai0201":${n},"gen":"12345678901234567890 in a string"}}]}`;
  for (const n of [
    "12345678901234567890", "-9007199254740993", "1e400", "-1E400", "12345678901234567890.0", "9007199254740993e0",
    "90071992547409930E-1", "9007199254740992.5", "-9007199254740992.5", "1e-400", "-0.0001e-399",
    "123456789012345678901234567890",
  ]) {
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(body(n), "application/json")).transport });
    await assert.rejects(e.getJson("/x/query"), (err: unknown) => {
      assert.ok(err instanceof RegionalatlasParseError, n);
      assert.equal(err.message, `Unexpected response from /x/query: the number ${n} cannot be represented exactly.`);
      return true;
    });
  }
  // What a double carries exactly, or as JSON means it (a decimal fraction below 2^53), passes.
  const exact: Array<[string, number]> = [
    ["9007199254740991", 9007199254740991], ["9007199254740992.0", 2 ** 53], ["9007199254740992e0", 2 ** 53],
    ["90071992547409920E-1", 2 ** 53], ["1e21", 1e21], ["1.2e21", 1.2e21], ["0", 0], ["-0", -0], ["0.0e-500", 0],
    ["1.10", 1.1], ["0.1", 0.1], ["1.00000000000000001", 1], ["5e-324", 5e-324], ["2222222222", 2222222222],
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
    assert.equal(err.message, "Unexpected response from https://***@cat.test/services.json: the number 1e400 cannot be represented exactly.");
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
