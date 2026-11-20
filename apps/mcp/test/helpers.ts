// Test helpers of this server's own tests and the adapters of the conformance tests: a mock of
// both Regionalatlas hosts (the client's recorded.ts: the catalogue and data answers recorded live
// on 2026-11-20 and cut down; it answers on any host, so the default hosts and a mirror alike),
// and the client's transport helpers. The generic harness (a connection, a config, a log recorder,
// the HTTP server) is harness.ts.

export * from "@maschinenlesbar.org/regionalatlas-client/test/helpers";
export * from "@maschinenlesbar.org/regionalatlas-client/test/recorded";
