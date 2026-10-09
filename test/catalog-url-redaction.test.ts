// The second configurable URL: --catalog-url / `catalogUrl` takes its own code path (an
// absolute URL, fetched with getJsonAbsolute), so the shared conformance tests, which use
// --base-url, are repeated for it here (findings 03#1, 03#2, 07 W5/W12/W13 of the
// 2026-10-05 review).

import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { run } from "../src/cli/run.js";
import { RegionalatlasClient } from "../src/client/client.js";
import { catalog, landData } from "./fixtures.js";

const PASSWORDS = ["s3cret-pw", "pa#ss-pw", "pa?ss-pw", "pa/ss-pw", "pa ss-pw", "o'brien-pw", "päss-pw", "p@ss-pw"];

function catalogUrls(pw: string): string[] {
  return [
    `https://alice:${pw}@mirror.example/services.json`,
    `https://alice:${pw}@mirror.example:99999/services.json`,
    `ftp://alice:${pw}@mirror.example/services.json`,
    `https://alice:${pw}@mirror.example/services.json `,
    // A username-only token; with "#", "?" or "/" in it the URL has no userinfo at all.
    ...(/[#?/]/.test(pw) ? [] : [`https://tok-${pw}@mirror.example/services.json`]),
  ];
}

function cli(body: string) {
  const out: string[] = [];
  const err: string[] = [];
  const transport = async (): Promise<HttpResponse> => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(body),
  });
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: (opts) => new RegionalatlasClient({ ...opts, transport }),
  };
  return { deps, text: () => [...out, ...err].join("\n") };
}

for (const pw of PASSWORDS) {
  test(`--catalog-url: no output path prints the password ${JSON.stringify(pw)}`, async () => {
    // A usable catalogue, one that isn't JSON, an empty body and the JSON literal null.
    for (const body of ['[{"title":"T","children":[]}]', "<html>login</html>", "", "null"]) {
      for (const url of catalogUrls(pw)) {
        for (const argv of [
          ["--catalog-url", url, "themes"],
          [`--catalog-url=${url}`, "indicators"],
          ["--catalog-url", url, "query", "AI002-1-5"],
          ["--catalog-url", "https://ok.example/c.json", "--catalog-url", url, "themes"],
        ]) {
          const c = cli(body);
          await run(argv, c.deps);
          for (const form of [pw, JSON.stringify(pw).slice(1, -1)]) {
            assert.ok(!c.text().includes(form), `body ${JSON.stringify(body)} argv ${JSON.stringify(argv)}:\n${c.text()}`);
          }
        }
      }
    }
  });
}

// ---- the library (P2): logged clients and every error of both hosts -----------------


const PW = "s3cret-Pw";
const DATA = `https://alice:${PW}@data.example`;
const CATALOG = `https://bob:${PW}@cat.example/services.json`;

function everything(value: unknown): string {
  let text = inspect(value, { depth: 10, showHidden: true });
  try {
    text += JSON.stringify(value);
  } catch {
    // circular: inspect covers it
  }
  if (value instanceof Error) {
    text += value.message + String((value as { url?: unknown }).url ?? "");
    for (let c: unknown = value.cause; c !== undefined && c !== null; c = (c as { cause?: unknown }).cause) {
      text += inspect(c, { depth: 10 }) + (c instanceof Error ? c.message : String(c));
    }
  }
  return text;
}

const json = (status: number, body: unknown): HttpResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
});

test("library: logging a client with both URLs credentialed never shows the password", () => {
  const client = new RegionalatlasClient({ baseUrl: DATA, catalogUrl: CATALOG, transport: async () => json(200, []) });
  assert.ok(!everything(client).includes(PW), everything(client));
});

test("library: no error of the catalogue or the data host carries the password", async () => {
  type Responder = (req: HttpRequest) => Promise<HttpResponse>;
  const onData = (respond: Responder): Responder => async (req) =>
    req.url.startsWith("https://bob:") ? json(200, catalog) : respond(req);
  const cases: Array<[string, Responder, (c: RegionalatlasClient) => Promise<unknown>]> = [
    ["catalogue not JSON", async () => json(200, "<html>login</html>"), (c) => c.themes()],
    ["catalogue empty", async () => json(200, ""), (c) => c.themes()],
    ["catalogue null", async () => json(200, "null"), (c) => c.themes()],
    ["catalogue 404 echoing the URL", async (req) => json(404, { message: `no ${req.url}` }), (c) => c.themes()],
    ["catalogue transport error with the URL", async (req) => { throw new TypeError(`Failed to fetch ${req.url}`); }, (c) => c.themes()],
    ["data 500 echoing the URL", onData(async (req) => json(500, { message: `boom ${req.url}` })), (c) => c.query({ indicator: "AI002-1-5", year: 2020 })],
    ["data ArcGIS envelope echoing the URL", onData(async (req) => json(200, { error: { code: 400, message: `bad ${req.url}`, details: [req.url] } })), (c) => c.query({ indicator: "AI002-1-5", year: 2020 })],
    ["data not JSON", onData(async (req) => json(200, `oops ${req.url}`)), (c) => c.query({ indicator: "AI002-1-5", year: 2020 })],
    ["data transport cause chain", onData(async (req) => { throw new Error("fetch failed", { cause: new Error(`connect ${req.url}`) }); }), (c) => c.query({ indicator: "AI002-1-5", year: 2020 })],
  ];
  for (const [label, transport, call] of cases) {
    const client = new RegionalatlasClient({ baseUrl: DATA, catalogUrl: CATALOG, transport, maxRetries: 0 });
    let err: unknown;
    try {
      await call(client);
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, `${label}: the call should have failed`);
    assert.ok(!everything(err).includes(PW), `${label}: ${everything(err)}`);
  }
  // The success path still works with credentialed URLs.
  const ok = new RegionalatlasClient({
    baseUrl: DATA,
    catalogUrl: CATALOG,
    transport: async (req) => (req.url.startsWith("https://bob:") ? json(200, catalog) : json(200, landData)),
  });
  assert.ok((await ok.query({ indicator: "AI002-1-5", year: 2020 })).length > 0);
});

test("P4 for --catalog-url: a '%' that isn't an escape in the userinfo is a usage error before any request", async () => {
  for (const url of ["https://alice:100%@cat.example/c.json", "https://al%ice:pw@cat.example/c.json"]) {
    let requests = 0;
    const out: string[] = [];
    const err: string[] = [];
    const deps: CliDeps = {
      io: { out: (s) => out.push(s), err: (s) => err.push(s) },
      createClient: (opts) => new RegionalatlasClient({ ...opts, transport: async () => (requests++, json(200, [])) }),
    };
    assert.equal(await run(["--catalog-url", url, "themes"], deps), 2, err.join("\n"));
    assert.equal(requests, 0);
    assert.match(err.join("\n"), /%25/);
    assert.throws(() => new RegionalatlasClient({ catalogUrl: url }), /%25/);
  }
  assert.doesNotThrow(() => new RegionalatlasClient({ catalogUrl: "https://alice:100%25@cat.example/c.json" }));
});

// ---- a `?token=` in the catalogue URL (an ArcGIS token) is a credential too ----------

const TOKEN = "tok-S3CRET-value_42";

test("--catalog-url ?token=: no output path prints the token", async () => {
  const urls = [
    `https://cat.example/services.json?token=${TOKEN}`,
    `https://cat.example/services.json?f=json&access_token=${TOKEN}`,
    `https://cat.example:99999/services.json?TOKEN=${TOKEN}`,
    `ftp://cat.example/services.json?token=${TOKEN}`,
    `https://cat.example/services.json?token=${TOKEN} `,
  ];
  for (const body of ['[{"title":"T","children":[]}]', "<html>login</html>", "", "null", `{"error":"Invalid token ${TOKEN}"}`]) {
    for (const url of urls) {
      for (const argv of [
        ["--catalog-url", url, "themes"],
        [`--catalog-url=${url}`, "indicators"],
        ["--catalog-url", url, "query", "AI002-1-5"],
      ]) {
        const c = cli(body);
        await run(argv, c.deps);
        assert.ok(!c.text().includes(TOKEN), `body ${JSON.stringify(body)} argv ${JSON.stringify(argv)}:\n${c.text()}`);
      }
    }
  }
});

test("library: no error of the catalogue carries its ?token=, and the token never reaches the data host", async () => {
  const catalogUrl = `https://cat.example/services.json?token=${TOKEN}`;
  const cases: Array<[string, (req: HttpRequest) => Promise<HttpResponse>]> = [
    ["not JSON", async () => json(200, "<html>login</html>")],
    ["empty", async () => json(200, "")],
    ["401 echoing the URL and the token", async (req) => json(401, { message: `bad token ${TOKEN} for ${req.url}` })],
    ["302 (not followed)", async (req) => ({ status: 302, headers: { location: req.url }, body: Buffer.alloc(0) })],
    ["transport error with the URL", async (req) => { throw new TypeError(`Failed to fetch ${req.url}`); }],
  ];
  for (const [label, transport] of cases) {
    const client = new RegionalatlasClient({ catalogUrl, transport, maxRetries: 0 });
    let err: unknown;
    try {
      await client.themes();
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, `${label}: the call should have failed`);
    assert.ok(!everything(err).includes(TOKEN), `${label}: ${everything(err)}`);
  }
  assert.ok(!everything(new RegionalatlasClient({ catalogUrl })).includes(TOKEN));

  // Success: the catalogue request carries the token, the data request never does.
  const seen: string[] = [];
  const ok = new RegionalatlasClient({
    catalogUrl,
    transport: async (req) => {
      seen.push(req.url);
      return req.url.startsWith("https://cat.example/") ? json(200, catalog) : json(200, landData);
    },
  });
  await ok.query({ indicator: "AI002-1-5", year: 2020 });
  assert.equal(seen.length, 2);
  assert.ok(seen[0]!.includes(`token=${TOKEN}`));
  assert.ok(!seen[1]!.includes(TOKEN), seen[1]);
});

test("redactUrl and redactQueryTokens hide token values", async () => {
  const { redactUrl, redactQueryTokens, queryTokensIn } = await import("../src/index.js");
  assert.equal(redactUrl(`https://h/s.json?a=1&token=${TOKEN}#x`), "https://h/s.json?a=1&token=***#x");
  assert.equal(redactUrl(`https://u:p@h:99999/s.json?Access_Token=${TOKEN}`), "https://***@h:99999/s.json?Access_Token=***");
  assert.deepEqual(queryTokensIn(`--catalog-url=https://h/?token=${TOKEN}&x=1`), [TOKEN]);
  assert.equal(redactQueryTokens(`invalid token ${TOKEN}`, [TOKEN]), "invalid token ***");
  // A short token is redacted only in its parameter form.
  assert.equal(redactQueryTokens("HTTP 500 ?token=5", ["5"]), "HTTP 500 ?token=***");
  // Other parameters are left alone.
  assert.equal(redactUrl("https://h/s.json?tokens=1&mytoken=2"), "https://h/s.json?tokens=1&mytoken=2");
});

test("a catalogue token equal to a part of the record's frame leaves the frame intact (#14)", async () => {
  // A token equal to the topic, the program or the year used to give `[***]`, `[***.api]`
  // or `***-01-02T…`: the redaction ran over the formatted record.
  const TS = "2026-01-02T03:04:05.678Z";
  for (const token of ["regionalatlas.api", "regionalatlas", "2026-01-02"]) {
    for (const format of ["text", "jsonl"]) {
      const err: string[] = [];
      const deps: CliDeps = {
        io: { out: () => {}, err: (s) => err.push(s) },
        now: () => new Date(TS),
        createClient: (opts) =>
          new RegionalatlasClient({ ...opts, transport: async () => json(500, { message: `invalid token ${token}` }), maxRetries: 0 }),
      };
      assert.equal(await run(["--log-format", format, "--catalog-url", `https://cat.example/services.json?token=${token}`, "themes"], deps), 1);
      assert.equal(err.length, 1, err.join("\n"));
      const line = err[0]!;
      if (format === "jsonl") {
        const record = JSON.parse(line) as Record<string, string>;
        assert.deepEqual([record["ts"], record["level"], record["topic"]], [TS, "ERROR", "regionalatlas.api"], line);
        assert.ok(!(record["msg"] ?? "").includes(token), line);
      } else {
        assert.ok(line.startsWith(`${TS} ERROR [regionalatlas.api] `), line);
        assert.ok(!line.slice(line.indexOf("] ") + 2).includes(token), line);
      }
    }
  }
});

test("a catalogue token the server echoes is redacted after its text is cleaned (#6 variant)", async () => {
  // `a"b\c d<U+202E>ef`, percent-encoded in the URL. The server echoes it decoded; the
  // message drops the bidi control and folds the space run, so the text no longer equals
  // any listed form and used to be printed as `a"b\c def`.
  const raw = "a%22b%5Cc%20d%E2%80%AEef-S3CRET";
  const client = new RegionalatlasClient({
    catalogUrl: `https://cat.example/services.json?token=${raw}`,
    transport: async () => json(500, { message: `invalid token ${decodeURIComponent(raw)}` }),
    maxRetries: 0,
  });
  await assert.rejects(client.themes(), (err: Error) => {
    assert.ok(!err.message.includes("S3CRET"), err.message);
    assert.match(err.message, /invalid token \*\*\*/);
    return true;
  });
});
