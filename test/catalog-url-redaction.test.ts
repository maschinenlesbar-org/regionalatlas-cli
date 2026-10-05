// The second configurable URL: --catalog-url / `catalogUrl` takes its own code path (an
// absolute URL, fetched with getJsonAbsolute), so the shared conformance tests, which use
// --base-url, are repeated for it here (findings 03#1, 03#2, 07 W5/W12/W13 of the
// 2026-10-05 review).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpResponse } from "../src/client/http.js";
import { run } from "../src/cli/run.js";
import { RegionalatlasClient } from "../src/client/client.js";

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
