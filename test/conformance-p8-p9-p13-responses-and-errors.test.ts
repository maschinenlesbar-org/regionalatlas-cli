// Conformance test P8 + P9 + P13 (fix plan 2026-10-06): a body is decoded by its declared
// charset (P8); a 2xx body without the documented shape is a parse error, never data or
// "nothing found" (P9); every rejected input is the library's validation error, never a raw
// TypeError or RangeError (P13). Shared across the *-cli repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { RegionalatlasClient as Client, filterByRegion, projectFields } from "../src/client/client.js";
import { resolveIndicator } from "../src/client/catalog.js";
import {
  RegionalatlasError as BaseError,
  RegionalatlasParseError as ParseError,
  RegionalatlasValidationError as ValidationError,
} from "../src/client/errors.js";
import type { QueryOptions, IndicatorFilter, RegionalatlasClientOptions } from "../src/index.js";
/** A call whose answer contains a text field, and how to read that field from the result. */
const textCall = (client: Client): Promise<unknown> => client.themes();
const textBody = (text: string): unknown => [{ title: text, children: [] }];
const readText = (result: unknown): string => (result as Array<{ title: string }>)[0]!.title;
/**
 * 2xx bodies the catalogue call must reject. `[]` is not one (an empty catalogue, which the
 * CLI reports), nor `[null]`: entries that aren't usable themes are left out by design.
 */
const malformedBodies: unknown[] = [null, {}, "text", 42, { error: "boom" }, { message: "Not available" }];
/** A transport that must never be reached: every bad call below fails before any request. */
const noNetwork = async (): Promise<never> => {
  throw new Error("a request was sent for a call that should have been rejected first");
};
const c = (): Client => new Client({ transport: noNetwork });
const q = (opts: unknown) => () => c().query(opts as QueryOptions);
const AI = "AI002-1-5";
/** Library calls with wrong-typed or out-of-range input. */
const badCalls: Array<[string, () => unknown]> = [
  ["query({ indicator: 2020 })", q({ indicator: 2020 })],
  ["query({ indicator: null })", q({ indicator: null })],
  ["query({})", q({})],
  ["query({ indicator: [AI] })", q({ indicator: [AI] })],
  ["query({ indicator: { code } })", q({ indicator: { code: AI } })],
  ["query(null)", q(null)],
  ["query(AI)", q(AI)],
  ["query({ year: '2020' })", q({ indicator: AI, year: "2020" })],
  ["query({ year: 2020.5 })", q({ indicator: AI, year: 2020.5 })],
  ["query({ level: 5 })", q({ indicator: AI, level: 5 })],
  ["query({ region: 1 })", q({ indicator: AI, region: 1 })],
  ["query({ fields: 'ai0201' })", q({ indicator: AI, fields: "ai0201" })],
  ["indicators(null)", () => c().indicators(null as unknown as IndicatorFilter)],
  ["indicators('x')", () => c().indicators("x" as unknown as IndicatorFilter)],
  ["indicators({ search: 5 })", () => c().indicators({ search: 5 as unknown as string })],
  ["indicators({ year: '20' })", () => c().indicators({ year: "20" })],
  ["resolveIndicator([], 5)", () => resolveIndicator([], 5 as unknown as string)],
  ["filterByRegion([], 5)", () => filterByRegion([], 5 as unknown as string)],
  ["projectFields([], 'x')", () => projectFields([], "x" as unknown as string[])],
  ["options 'x'", () => new Client("x" as unknown as RegionalatlasClientOptions)],
  ["timeoutMs: 'x'", () => new Client({ timeoutMs: "x" as unknown as number })],
  ["timeoutMs: -1", () => new Client({ timeoutMs: -1 })],
  ["maxRetries: 1.5", () => new Client({ maxRetries: 1.5 })],
  ["retryDelayMs: 3e9", () => new Client({ retryDelayMs: 3_000_000_000 })],
  ["baseUrl: 5", () => new Client({ baseUrl: 5 as unknown as string })],
  ["catalogUrl: 5", () => new Client({ catalogUrl: 5 as unknown as string })],
  ["userAgent: {}", () => new Client({ userAgent: {} as unknown as string })],
  ["defaultHeaders: 'x'", () => new Client({ defaultHeaders: "x" as unknown as Record<string, string> })],
  ["transport: 'x'", () => new Client({ transport: "x" as unknown as never })],
  ["sleep: 5", () => new Client({ sleep: 5 as unknown as never })],
];
// --------------------------------------------------------------------------------------

const respond = (body: Buffer, contentType: string) => async (): Promise<HttpResponse> => ({
  status: 200,
  headers: { "content-type": contentType },
  body,
});

test("P8: a body is decoded by its declared charset", async () => {
  const text = "Müller µg/l";
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const body = Buffer.from(JSON.stringify(textBody(text)), encoding);
    const client = new Client({ transport: respond(body, `application/json; charset=${charset}`) });
    assert.equal(readText(await textCall(client)), text, charset);
  }
});

test("P9: a 2xx body without the documented shape is a parse error", async () => {
  for (const body of malformedBodies) {
    const client = new Client({ transport: respond(Buffer.from(JSON.stringify(body)), "application/json"), maxRetries: 0 });
    await assert.rejects(textCall(client), ParseError, `body ${JSON.stringify(body)}`);
  }
  for (const raw of ["", "<html>maintenance</html>"]) {
    const client = new Client({ transport: respond(Buffer.from(raw), "text/html"), maxRetries: 0 });
    await assert.rejects(textCall(client), BaseError, `raw ${JSON.stringify(raw)}`);
  }
});

test("P13: every rejected input is the validation error, never a raw TypeError", async () => {
  for (const [label, fn] of badCalls) {
    await assert.rejects(async () => fn(), (e: unknown) => e instanceof ValidationError, label);
  }
});
