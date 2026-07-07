// The request engine: turns logical (path, query) calls into HTTP GET requests via
// a Transport, applies retry/backoff for transient statuses (429, 503), and decodes
// JSON responses. The Regionalatlas is backed by an ArcGIS MapServer — an
// unauthenticated GET API whose parameters travel in the query string.
//
// Two-host note: the *data* queries hit the ArcGIS MapServer (`baseUrl`, default
// the gis-idmz.nrw.de host), while the *indicator catalogue* is a static JSON file
// on the statistikportal.de host. The engine therefore also supports GETting a
// fully-qualified absolute URL (`requestAbsolute`) so the catalogue can be fetched
// without changing the data `baseUrl`.

import { nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  RegionalatlasApiError,
  RegionalatlasNetworkError,
  RegionalatlasParseError,
} from "./errors.js";

/** The ArcGIS MapServer host that answers the dynamicLayer data queries. */
export const DEFAULT_BASE_URL = "https://www.gis-idmz.nrw.de";
const DEFAULT_USER_AGENT = "regionalatlas-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

export interface EngineOptions {
  /** Base URL of the ArcGIS data host. Defaults to the gis-idmz.nrw.de MapServer host. */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /** Value of the User-Agent header. */
  userAgent?: string;
  /** Extra headers sent on every request. */
  defaultHeaders?: Record<string, string>;
  /** Per-request timeout in milliseconds (0 disables). */
  timeoutMs?: number;
  /** Number of automatic retries for transient (429/503) responses. */
  maxRetries?: number;
  /** Base backoff between retries in milliseconds (grows linearly). */
  retryDelayMs?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/**
 * Strip control characters out of a string that originates in an
 * attacker-controlled response — the ArcGIS `error` detail and the non-JSON body
 * snippet — before it flows into a `RegionalatlasApiError.message` that run.ts
 * prints raw to stderr. `JSON.parse` decodes an escaped ESC (a backslash-u-001b
 * sequence) in an error body into a real ESC byte, so without this a hostile or
 * MITM'd endpoint could inject
 * ANSI/OSC terminal escape sequences (screen clears, title changes, output
 * spoofing) when the message reaches the user's terminal. The success path is
 * already safe (`JSON.stringify` escapes these). Removes all C0 controls (except
 * tab/newline), DEL, and the C1 range; implemented via char codes so this source
 * file never contains a raw control byte.
 */
export function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    if (n === 0x09 || n === 0x0a) {
      out += ch;
      continue;
    }
    if (n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reject a request URL whose scheme is not http/https, before it reaches the
 * transport. Defence-in-depth for library consumers who inject a custom Transport
 * (the CLI and the default transport already reject non-http(s) URLs).
 */
function assertHttpScheme(url: string): void {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new RegionalatlasNetworkError(`Invalid request URL: ${url}`);
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new RegionalatlasNetworkError(
      `Unsupported URL scheme "${protocol}" — only http and https are allowed.`,
    );
  }
}

export class RequestEngine {
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.transport = options.transport ?? nodeHttpTransport;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 200;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.sleep = options.sleep ?? realSleep;
  }

  /** Build a fully-qualified URL from a path (on the data host) and optional query. */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /** Build a fully-qualified URL from an absolute base URL and optional query. */
  buildAbsoluteUrl(absoluteUrl: string, query?: QueryParams): string {
    const qs = query ? buildQueryString(query) : "";
    if (!qs) return absoluteUrl;
    return absoluteUrl.includes("?") ? `${absoluteUrl}&${qs}` : `${absoluteUrl}?${qs}`;
  }

  /**
   * Perform a GET with Accept negotiation and transient-error retries. Redirects
   * are NOT followed — the canonical host answers directly, so a 3xx surfaces as
   * an error.
   */
  private async requestUrl(url: string, accept: string): Promise<RawResponse> {
    // Enforce http(s) at the engine boundary too. The CLI validates
    // --base-url/--catalog-url at parse time and the default transport re-checks,
    // but a library consumer injecting a custom Transport would otherwise inherit no
    // scheme guard. This covers both the data host and the absolute catalogue URL.
    assertHttpScheme(url);
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      Accept: accept,
      "User-Agent": this.userAgent,
    };

    let attempt = 0;
    for (;;) {
      const response = await this.transport({
        method: "GET",
        url,
        headers,
        timeoutMs: this.timeoutMs,
        ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
      });

      const status = response.status;
      const retryable = status === 429 || status === 503;
      if (retryable && attempt < this.maxRetries) {
        attempt += 1;
        await this.sleep(this.retryDelayMs * attempt);
        continue;
      }

      const contentType = String(response.headers["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(url, status, response.body);
      }

      return { data: response.body, contentType, status };
    }
  }

  /** GET a path on the data host with query params. */
  async request(path: string, query?: QueryParams, accept = "application/json"): Promise<RawResponse> {
    return this.requestUrl(this.buildUrl(path, query), accept);
  }

  /** GET a path on the data host and parse the JSON reply into `T`. */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    return this.decodeJson<T>(await this.request(path, query), path);
  }

  /** GET a fully-qualified absolute URL (e.g. the catalogue host) and parse JSON into `T`. */
  async getJsonAbsolute<T>(absoluteUrl: string, query?: QueryParams): Promise<T> {
    const url = this.buildAbsoluteUrl(absoluteUrl, query);
    return this.decodeJson<T>(await this.requestUrl(url, "application/json"), url);
  }

  private decodeJson<T>(res: RawResponse, source: string): T {
    const text = res.data.toString("utf8");
    if (res.status === 204 || text.trim().length === 0) {
      return null as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new RegionalatlasParseError(`Failed to parse JSON response from ${source}`, { cause });
    }
  }

  private toApiError(url: string, status: number, body: Buffer): RegionalatlasApiError {
    const text = body.toString("utf8");
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: unknown };
        message?: unknown;
        detail?: unknown;
      };
      if (parsed?.error && typeof parsed.error.message === "string") detail = parsed.error.message;
      else if (typeof parsed?.message === "string") detail = parsed.message;
      else if (typeof parsed?.detail === "string") detail = parsed.detail;
    } catch {
      // Not JSON (e.g. an HTML error page). Surface a short, whitespace-collapsed
      // snippet of a textual body; skip HTML pages (start with "<").
      const snippet = text.trim().replace(/\s+/g, " ");
      if (snippet.length > 0 && !snippet.startsWith("<")) {
        detail = snippet.length > 200 ? `${snippet.slice(0, 200)}…` : snippet;
      }
    }
    // `detail` came from the attacker-controlled response body; strip control
    // characters so a hostile endpoint cannot drive terminal escape sequences
    // into stderr via the error message.
    if (detail !== undefined) detail = sanitizeServerText(detail);
    return new RegionalatlasApiError({ status, url, method: "GET", body: text, detail });
  }
}
