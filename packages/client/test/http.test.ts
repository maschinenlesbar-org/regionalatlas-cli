import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { nodeHttpTransport } from "../src/http.js";
import { RequestEngine } from "../src/engine.js";
import { RegionalatlasNetworkError } from "../src/errors.js";

/** Start a throwaway loopback server for one test and return its base URL. */
async function withServer(
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("performs a real GET and returns status, headers and body", async () => {
  await withServer(
    (req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ path: req.url }));
    },
    async (baseUrl) => {
      const resp = await nodeHttpTransport({ method: "GET", url: `${baseUrl}/query?where=1%3D1` });
      assert.equal(resp.status, 200);
      assert.deepEqual(JSON.parse(resp.body.toString("utf8")), { path: "/query?where=1%3D1" });
    },
  );
});

test("rejects an unsupported protocol with RegionalatlasNetworkError", async () => {
  await assert.rejects(
    () => nodeHttpTransport({ method: "GET", url: "ftp://example.test/x" }),
    RegionalatlasNetworkError,
  );
});

test("timeoutMs bounds the whole response, not just idle gaps", async () => {
  // A server that trickles a byte every 50 ms for 2 s never goes idle for the timeout.
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("[");
      const drip = setInterval(() => res.write(" "), 50);
      const finish = setTimeout(() => res.end("]"), 2000);
      res.on("close", () => {
        clearInterval(drip);
        clearTimeout(finish);
      });
    },
    async (baseUrl) => {
      const started = Date.now();
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, timeoutMs: 300 }),
        (err) => err instanceof RegionalatlasNetworkError && /timed out after 300ms/.test(err.message),
      );
      assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
    },
  );
});

test("a timeoutMs beyond Node's timer range is capped, not fired after 1 ms", async () => {
  const warnings: string[] = [];
  const onWarning = (warning: Error) => void warnings.push(warning.name);
  process.on("warning", onWarning);
  try {
    await withServer(
      (_req, res) => void setTimeout(() => res.end("{}"), 50),
      async (baseUrl) => {
        const resp = await nodeHttpTransport({ method: "GET", url: baseUrl, timeoutMs: 3_000_000_000 });
        assert.equal(resp.body.toString("utf8"), "{}");
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(warnings.filter((name) => name === "TimeoutOverflowWarning"), []);
  } finally {
    process.off("warning", onWarning);
  }
});

test("enforces maxResponseBytes", async () => {
  await withServer(
    (_req, res) => res.end("x".repeat(1000)),
    async (baseUrl) => {
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, maxResponseBytes: 10 }),
        RegionalatlasNetworkError,
      );
    },
  );
});

test("a header Node refuses is a RegionalatlasNetworkError, not a raw TypeError", async () => {
  await assert.rejects(
    nodeHttpTransport({ method: "GET", url: "http://127.0.0.1:9/", headers: { "User-Agent": "a\r\nb" } }),
    (err: unknown) => {
      assert.ok(err instanceof RegionalatlasNetworkError, String(err));
      assert.match((err as Error).message, /^Invalid request: /);
      return true;
    },
  );
});

test("a URL typed without its scheme is refused without its user name, token or password (F5 class)", async () => {
  // `my_user:pw@h` doesn't parse ("_" is no scheme character) and was quoted with its password;
  // `T0kenS3cret:@h` parses with the token as its scheme, which the message named, lower-cased.
  for (const url of ["my_user:s3cret-pw@h.example/x", "T0kenS3cret:@h.example/x", "alice:s3cret-pw@h.example/x"]) {
    const err = await nodeHttpTransport({ method: "GET", url, headers: {} }).then(
      () => assert.fail(`${url}: accepted`),
      (caught: unknown) => caught,
    );
    assert.ok(err instanceof RegionalatlasNetworkError, String(err));
    assert.ok(!/s3cret|t0kens3cret|T0kenS3cret|my_user|alice/.test(err.message), err.message);
    assert.match(err.message, /\*\*\*@h\.example\/x/);
  }
  // A scheme spelled as one (`scheme://`) is still named.
  const ftp = await nodeHttpTransport({ method: "GET", url: "ftp://alice:s3cret-pw@h.example/x", headers: {} }).catch((e: unknown) => e);
  assert.ok(ftp instanceof RegionalatlasNetworkError && ftp.message === 'Unsupported protocol "ftp:" in URL: ftp://***@h.example/x', String(ftp));
});

test("the engine's per-request scheme check never quotes a scheme-less URL's user name, token or password (F5 class)", async () => {
  // getJsonAbsolute is public: an absolute URL typed without its scheme reached assertHttpScheme,
  // which quoted it unredacted (`Invalid request URL: my_user:pw@h`) or named the token as the
  // scheme (`Unsupported URL scheme "t0kens3cret:"`).
  let sent = 0;
  const e = new RequestEngine({ transport: async () => (sent++, { status: 200, headers: {}, body: Buffer.from("[]") }) });
  for (const url of ["my_user:s3cret-pw@h.example/x", "T0kenS3cret:@h.example/x"]) {
    const err = await e.getJsonAbsolute(url).catch((caught: unknown) => caught);
    assert.ok(err instanceof RegionalatlasNetworkError, String(err));
    assert.ok(!/s3cret|t0kens3cret|T0kenS3cret|my_user/.test(err.message), err.message);
  }
  const ftp = await e.getJsonAbsolute("ftp://alice:s3cret-pw@h.example/x").catch((caught: unknown) => caught);
  assert.ok(ftp instanceof RegionalatlasNetworkError && /"ftp:"/.test(ftp.message) && !ftp.message.includes("s3cret"), String(ftp));
  assert.equal(sent, 0);
});
