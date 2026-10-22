// Conformance test P27 (fix plan 2026-10-21, D2 and D7): a big or odd answer is printed or
// refused in one clean record, within memory; never a heap crash, never output `jq` can't read.
// - A large flat answer prints with --compact under a small heap: the check for huge strings
//   before printing walks it without an allocation per value (Object.entries made one pair per
//   element: 7 GB and a crash on 48M numbers).
// - An answer full of DEL characters, each printed as six (`\u007f`), prints under a small heap,
//   or, past V8's longest string, is an ERROR record of <bin>.output that says it is too large;
//   one `+=` per character made a rope of 100 M pieces and crashed.
// - A lone surrogate in an answer (`"\ud800"`) and bytes that are not valid UTF-8 are replaced
//   with U+FFFD, with one WARN record of <bin>.api naming the count and the request; the output is
//   well-formed and the run succeeds (one bad character never sinks a whole answer).
// The memory cases run the built bin in a child process with --max-old-space-size. Shared across
// the *-cli repos that print JSON; only the adapter differs. A repo whose mock must answer more
// than one request (here the catalogue and the data query) sets `hostArgv` and `answerFor`.

import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

// ---- adapter (per repo) -------------------------------------------------------------
/** The built bin, relative to this compiled test file (dist/test/…). */
const BIN = fileURLToPath(new URL("../src/cli/index.js", import.meta.url));
/**
 * `parity` as in P24, with `rawResponse(body, contentType)`. A query reads the catalogue first:
 * this `parity` answers the catalogue host with the fixture catalogue and sends the data query to
 * the test's responder; the library's error is mapped to `{ name, message }`.
 */
import { parity as repoParity, rawResponse, jsonResponse } from "./helpers.js";
import { catalog } from "@maschinenlesbar.org/regionalatlas-client/test/fixtures";
import type { HttpRequest, HttpResponse, Transport } from "@maschinenlesbar.org/regionalatlas-client/internal/http";
async function parity(argv: string[], call: (transport: Transport) => unknown, responder: (req: HttpRequest) => HttpResponse) {
  const o = await repoParity(argv, call, (req) =>
    new URL(req.url).hostname.includes("statistikportal") ? jsonResponse(catalog) : responder(req),
  );
  const error = o.lib.ok ? undefined : o.lib.error;
  return {
    cli: o.cli,
    lib: {
      ok: o.lib.ok,
      value: o.lib.ok ? o.lib.value : undefined,
      error: error instanceof Error ? { name: error.name, message: error.message } : error === undefined ? undefined : { name: "", message: String(error) },
      requests: o.lib.requests,
    },
  };
}
import { RegionalatlasClient as Client } from "@maschinenlesbar.org/regionalatlas-client/internal/client";
/** CLI argv (after the global options) for a call whose answer carries a free-form value, and the same call in the library. */
const call = ["query", "AI002-1-5", "--level", "land", "--year", "2020"];
const lib = (client: Client): Promise<unknown> => client.query({ indicator: "AI002-1-5", level: "land", year: 2020 });
/** The raw 2xx body with `json` (a JSON value, written as is) as that value: the region name. */
const bodyWith = (json: string): string => `{"features":[{"attributes":{"id":1,"typ":1,"ags":"01","jahr":2020,"gen":${json},"ai0201":1}}]}`;
/** The value from the CLI's printed result and from the library's. */
const fromCli = (out: string): unknown => (JSON.parse(out) as Array<{ name: unknown }>)[0]?.name;
const fromLib = (value: unknown): unknown => (value as Array<{ name: unknown }>)[0]?.name;
/** The log program, as in `WARN [<bin>.api]`. */
const PROGRAM = "regionalatlas";
/** The exit code of a failed output in this repo (most repos use 1). */
const OUTPUT_EXIT = 1;
/** The global options that point the CLI at the mock (default: `--base-url`); here the catalogue too. */
const hostArgv = (base: string): string[] => ["--base-url", base, "--catalog-url", `${base}/services.json`];
/** What the mock answers to the request for `path` (default: the test's body); here the catalogue first. */
const answerFor = (path: string, body: Buffer): Buffer => (path === "/services.json" ? Buffer.from(JSON.stringify(catalog)) : body);
/**
 * The flat-answer case can't apply: a query prints rows of figures, a region name or `null`, so
 * no answer prints an array of 8 M numbers (an attribute holding one is an unreadable value).
 */
const NOT_FREE_FORM = "regionalatlas prints rows: a value is a figure, a region name or null, never an array";
const test = (name: string, options: { timeout?: number } | (() => Promise<void>), fn?: () => Promise<void>): void => {
  const run = (typeof options === "function" ? options : fn) as () => Promise<void>;
  const opts = typeof options === "function" ? {} : options;
  void nodeTest(name, name.includes("large flat answer") ? { ...opts, skip: NOT_FREE_FORM } : opts, run);
};
import { test as nodeTest } from "node:test";
// --------------------------------------------------------------------------------------

// These tests start the built CLI as a process: 30 s instead of the suite's 5 s.
const STARTS_A_PROCESS = { timeout: 30_000 };

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
}

/** Serve `body` (as JSON) to one run of the bin with a heap of `heapMb`, then stop. */
async function runWithAnswer(body: Buffer, heapMb: number, argv: string[] = []): Promise<Run> {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(answerFor(req.url ?? "", body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return await new Promise<Run>((resolve) => {
      const child = spawn(
        process.execPath,
        [`--max-old-space-size=${heapMb}`, BIN, ...hostArgv(base), "--max-retries", "0", ...argv, ...call],
        { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } },
      );
      const out: Buffer[] = [];
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("close", (code, signal) => resolve({ code, signal, stdout: Buffer.concat(out), stderr }));
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** No crash: no V8 out-of-memory report, no abort, no stack. */
function noCrash(run: Run, label: string): void {
  assert.notEqual(run.signal, "SIGABRT", `${label}: aborted`);
  assert.ok(run.code !== null && run.code !== 134, `${label}: exit ${run.code} ${run.signal}`);
  assert.doesNotMatch(run.stderr, /FATAL ERROR|heap out of memory|Allocation failed|\n\s+at /, `${label}: ${run.stderr.slice(0, 500)}`);
}

test("P27: a large flat answer prints with --compact within a small heap", STARTS_A_PROCESS, async () => {
  const n = 8_000_000;
  const run = await runWithAnswer(Buffer.from(bodyWith(`[${"1,".repeat(n - 1)}1]`)), 256, ["--compact"]);
  noCrash(run, "flat");
  assert.equal(run.code, 0, run.stderr.slice(0, 500));
  const printed = fromCli(run.stdout.toString("utf8")) as unknown[];
  assert.equal(printed.length, n);
});

test("P27: an answer full of DEL characters prints escaped within a small heap", STARTS_A_PROCESS, async () => {
  const n = 20_000_000;
  const run = await runWithAnswer(Buffer.from(bodyWith(`"${"\u007f".repeat(n)}"`), "latin1"), 512, ["--compact"]);
  noCrash(run, "DEL");
  assert.equal(run.code, 0, run.stderr.slice(0, 500));
  const text = run.stdout.toString("utf8");
  assert.ok(!text.includes("\u007f"), "a DEL is printed raw");
  assert.equal(fromCli(text), "\u007f".repeat(n));
});

test("P27: an answer that escaped would pass V8's longest string is an ERROR record, not a crash", STARTS_A_PROCESS, async () => {
  // 90 MB of DEL, under the default size cap: printed as `\u007f` each, 540 M characters.
  const run = await runWithAnswer(Buffer.from(bodyWith(`"${"\u007f".repeat(90_000_000)}"`), "latin1"), 512);
  noCrash(run, "90 MB of DEL");
  assert.equal(run.code, OUTPUT_EXIT, run.stderr.slice(0, 500));
  assert.equal(run.stdout.length, 0);
  assert.match(run.stderr, new RegExp(`ERROR \\[${PROGRAM}\\.output\\] The answer is too large to print`), run.stderr.slice(0, 500));
});

/** The body with the string value `a<bytes>b`, the bytes as they are. */
const withBytes = (bytes: number[]): Buffer => {
  const [head = "", tail = ""] = bodyWith('"a\u0000b"').split("\u0000");
  return Buffer.concat([Buffer.from(head), Buffer.from(bytes), Buffer.from(tail)]);
};

const WELL_FORMED = (text: string): boolean => !/[\ud800-\udfff]/u.test(text) && !/\\u[dD][89abAB][0-9a-fA-F]{2}(?!\\u[dD][c-fC-F])/.test(text);

test("P27: a lone surrogate or invalid bytes are replaced with U+FFFD and reported, never silent or fatal", async () => {
  const cases: Array<[string, Buffer, string, number]> = [
    ["a lone high surrogate", Buffer.from(bodyWith('"a\\ud800b"')), "a\ufffdb", 1],
    ["a lone low surrogate and a pair", Buffer.from(bodyWith('"\\udc00\\ud83d\\ude00"')), "\ufffd\u{1f600}", 1],
    ["invalid UTF-8", withBytes([0xff, 0xfe]), "a\ufffd\ufffdb", 2],
  ];
  for (const [label, body, expected, count] of cases) {
    const o = await parity(call, (t) => lib(new Client({ transport: t })), () => rawResponse(body, "application/json"));
    assert.equal(o.cli.code, 0, `${label}: ${o.cli.err}`);
    assert.ok(WELL_FORMED(o.cli.out), `${label}: ${o.cli.out}`);
    assert.equal(fromCli(o.cli.out), expected, label);
    const warn = new RegExp(
      `^WARN  \\[${PROGRAM}\\.api\\] GET \\S+: ${count} characters? of the answer (was|were) not valid text .*replaced with U\\+FFFD\\.$`,
    );
    assert.match(o.cli.err, warn, `${label}: ${o.cli.err}`);
    assert.equal(o.lib.ok, true, `${label}: ${o.lib.error?.message}`);
    assert.equal(fromLib(o.lib.value), expected, label);
  }
});
