// How the MCP server reaches this repository's client. The server's generic files (server.ts,
// limiter.ts, config.ts, run.ts, result.ts: the kit, the same in every repository) import the
// client only through this file, under the names below; the names on the right are this
// client's. Per repository, like tools.ts: a client whose names or functions differ adapts here.
//
// The Regionalatlas lives on two hosts: the indicator catalogue (services.json on
// regionalatlas.statistikportal.de) and the ArcGIS data host (www.gis-idmz.nrw.de). The server has
// one --base-url: a mirror of both (its /taskrunner/services.json and /arcgis/… under one base), as
// the mock upstreams of the tests, the image smoke test and the interop check are. Without it, each
// host is its default. The API base a result's `source` starts with is the catalogue's host (every
// call reads the catalogue first); the data host's query is named as an absolute URL.
// REGIONALATLAS_BASE_URL is the CLI's: the server reads no environment variable.

import { DATA_PATH, DEFAULT_CATALOG_URL, RegionalatlasClient, type RegionalatlasClientOptions } from "@maschinenlesbar.org/regionalatlas-client";
import { DEFAULT_BASE_URL } from "@maschinenlesbar.org/regionalatlas-client";
import { sizeLimitMessage as clientSizeLimitMessage } from "@maschinenlesbar.org/regionalatlas-client/internal/http";

export {
  RegionalatlasError as ClientError,
  RegionalatlasNetworkError as NetworkError,
  baseUrlProblem,
  DEFAULT_BASE_URL,
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "@maschinenlesbar.org/regionalatlas-client";
export { cutText, toWellFormed } from "@maschinenlesbar.org/regionalatlas-client/internal/errors";

const strip = (url: string): string => url.replace(/\/+$/, "");

/**
 * What the client's size-cap error says, in both its forms: the client names the download
 * ("Response exceeded …", "The indicator catalogue exceeded …"), and every call reads the
 * catalogue first, so the server matches the part they share.
 */
export function sizeLimitMessage(maxBytes: number): string {
  return clientSizeLimitMessage(maxBytes).replace(/^Response /, "");
}

/** The catalogue's path under its host (and under a mirror). */
const CATALOG_PATH = new URL(DEFAULT_CATALOG_URL).pathname;

/** The catalogue's host: the API base when no --base-url names a mirror. */
const CATALOG_ORIGIN = new URL(DEFAULT_CATALOG_URL).origin;

/** How long the server keeps the catalogue: the statistical offices add years and indicators without notice. */
export const CATALOG_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * How long the server keeps a data answer (one indicator, level and year; the client keeps the
 * last three): the pages of a map and a comparison of the same level read it once, where each
 * page of a Gemeinde map asked the data host for all 11,000 rows (4 MB) again.
 */
export const DATA_MAX_AGE_MS = 10 * 60 * 1000;

/** The API's base URL as a result's `source` starts with it (`--base-url`, else the catalogue's host). */
export function apiBase(baseUrl: string | undefined): string {
  return strip(baseUrl ?? CATALOG_ORIGIN);
}

/** The catalogue's URL for an API base: under the mirror, or the default. */
export function catalogSource(base: string): string {
  return `${strip(base)}${CATALOG_PATH}`;
}

/** The data query's URL for an API base: under the mirror, or on the default data host. */
export function dataSource(base: string): string {
  return `${strip(base) === CATALOG_ORIGIN ? strip(DEFAULT_BASE_URL) : strip(base)}${DATA_PATH}`;
}

/** The client with one base for both hosts: `baseUrl` (a mirror) serves the catalogue too; the catalogue kept 6 hours, a data answer 10 minutes. */
export class Client extends RegionalatlasClient {
  constructor(options: RegionalatlasClientOptions = {}) {
    super({
      ...options,
      catalogMaxAgeMs: CATALOG_MAX_AGE_MS,
      dataMaxAgeMs: DATA_MAX_AGE_MS,
      ...(options.baseUrl === undefined ? {} : { catalogUrl: catalogSource(options.baseUrl) }),
    });
  }
}
