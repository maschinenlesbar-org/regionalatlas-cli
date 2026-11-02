// Security audit 2026-10-27, class B: with a credential in the run (userinfo in --base-url,
// --catalog-url or REGIONALATLAS_BASE_URL, or a ?token= in --catalog-url), every stdout text
// goes through the userinfo backstop. Its scheme regex was tried at every word start and
// scanned on: quadratic on host text such as `a.a.a.…`, and the run stalled for seconds after
// the transport deadline. The pass is linear now.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpResponse } from "@maschinenlesbar.org/regionalatlas-client/internal/http";
import { run } from "../src/cli/run.js";
import { RegionalatlasClient } from "@maschinenlesbar.org/regionalatlas-client/internal/client";

const CREDENTIALS: Array<{ name: string; argv: string[]; env?: Record<string, string> }> = [
  { name: "userinfo in --base-url", argv: ["--base-url", "https://alice:s3cret-Pw@mirror.example"] },
  { name: "userinfo in REGIONALATLAS_BASE_URL", argv: [], env: { REGIONALATLAS_BASE_URL: "https://alice:s3cret-Pw@mirror.example" } },
  { name: "userinfo in --catalog-url", argv: ["--catalog-url", "https://alice:s3cret-Pw@mirror.example/services.json"] },
  { name: "a ?token= in --catalog-url", argv: ["--catalog-url", "https://mirror.example/services.json?token=s3cret-T0ken"] },
];

for (const { name, argv, env } of CREDENTIALS) {
  test(`the redaction of stdout is linear in the answer, with ${name}`, async () => {
    // 200 000 characters of `a.a.…` took about 8 s with the regex; the linear pass takes milliseconds.
    const title = "a.".repeat(100_000);
    const out: string[] = [];
    const err: string[] = [];
    const transport = async (): Promise<HttpResponse> => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify([{ title, children: [] }])),
    });
    const deps: CliDeps = {
      io: { out: (s) => out.push(s), err: (s) => err.push(s) },
      createClient: (opts) => new RegionalatlasClient({ ...opts, transport }),
      env: env ?? {},
    };
    const started = performance.now();
    const code = await run([...argv, "themes"], deps);
    const ms = performance.now() - started;
    assert.equal(code, 0, err.join("\n"));
    assert.ok(out.join("").includes(title), "the title is printed whole");
    assert.ok(ms < 1500, `${Math.round(ms)} ms`);
  });
}
