// Compile-time checks of the exported option types, and the runtime rule they describe: an
// option given as undefined means what an omitted one means.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RegionalatlasClient } from "../src/index.js";
import { makeMockTransport, routeByHost } from "./helpers.js";
import * as fx from "./fixtures.js";

// Runs the TypeScript compiler over a consumer file.
const STARTS_A_PROCESS = { timeout: 30_000 };
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("a consumer with the strictest compiler settings can pass undefined for any option", STARTS_A_PROCESS, async () => {
  // Under exactOptionalPropertyTypes, `{ baseUrl: process.env.X }` fails to compile against an
  // option declared `?: string`, although the runtime treats undefined as omitted.
  const dir = mkdtempSync(join(tmpdir(), "regionalatlas-types-"));
  try {
    writeFileSync(
      join(dir, "use.ts"),
      [
        `import { RegionalatlasClient, type EngineOptions, type RegionalatlasClientOptions, type IndicatorFilter, type QueryOptions } from ${JSON.stringify(INDEX)};`,
        "declare function allUndefined<T>(): { [K in keyof T]-?: undefined };",
        "export const engine: EngineOptions = allUndefined<EngineOptions>();",
        "export const options: RegionalatlasClientOptions = allUndefined<RegionalatlasClientOptions>();",
        "export const filter: IndicatorFilter = allUndefined<IndicatorFilter>();",
        "export const query: QueryOptions = { ...allUndefined<Omit<QueryOptions, \"indicator\">>(), indicator: \"AI002-1-5\" };",
        "export const client = new RegionalatlasClient({ baseUrl: process.env.REGIONALATLAS_BASE_URL, catalogUrl: process.env.X, timeoutMs: 15_000 });",
        "export const rows = async (): Promise<number> => (await client.query({ indicator: \"AI002-1-5\", region: process.env.R, year: undefined })).length;",
        "export const list = async (): Promise<number> => (await client.indicators({ search: process.env.S, theme: undefined })).length;",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
        },
        files: ["use.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr }),
      );
    });
    assert.equal(result.code, 0, result.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an option given as undefined means its default, as an omitted one does", async () => {
  const mt = makeMockTransport(routeByHost(fx.catalog, fx.landData));
  const client = new RegionalatlasClient({
    baseUrl: undefined,
    catalogUrl: undefined,
    userAgent: undefined,
    defaultHeaders: undefined,
    timeoutMs: undefined,
    maxRetries: undefined,
    retryDelayMs: undefined,
    maxResponseBytes: undefined,
    sleep: undefined,
    onRetry: undefined,
    transport: mt.transport,
  });
  const all = await client.indicators({ theme: undefined, year: undefined, search: undefined });
  assert.equal(all.length, (await new RegionalatlasClient({ transport: mt.transport }).indicators()).length);
  const rows = await client.query({ indicator: "AI002-1-5", level: undefined, year: undefined, region: undefined, fields: undefined });
  const plain = await new RegionalatlasClient({ transport: mt.transport }).query({ indicator: "AI002-1-5" });
  assert.deepEqual(rows, plain);
  assert.ok(rows.length > 0);
  const urls = mt.calls.map((r) => new URL(r.url).host);
  assert.ok(urls.includes("regionalatlas.statistikportal.de"));
  assert.ok(urls.includes("www.gis-idmz.nrw.de"));
  assert.equal(mt.calls[0]?.headers?.["User-Agent"], "regionalatlas-cli");
});
