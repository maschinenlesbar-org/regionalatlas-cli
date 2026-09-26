// The request engine: turns logical (path, query) calls into HTTP GET requests via
// a Transport, applies retry/backoff for transient statuses (429, 503) — honouring
// Retry-After when the server sends one — and decodes JSON responses. The Regionalatlas is backed by an ArcGIS MapServer — an
// unauthenticated GET API whose parameters travel in the query string.
//
// Two-host note: the *data* queries hit the ArcGIS MapServer (`baseUrl`, default
// the gis-idmz.nrw.de host), while the *indicator catalogue* is a static JSON file
// on the statistikportal.de host. The engine therefore also supports GETting a
// fully-qualified absolute URL (`requestAbsolute`) so the catalogue can be fetched
// without changing the data `baseUrl`.

import { MAX_TIMEOUT_MS, nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  RegionalatlasApiError,
  RegionalatlasNetworkError,
  RegionalatlasParseError,
  RegionalatlasValidationError,
  redactUrl,
} from "./errors.js";

/** The ArcGIS MapServer host that answers the dynamicLayer data queries. */
export const DEFAULT_BASE_URL = "https://www.gis-idmz.nrw.de";
const DEFAULT_USER_AGENT = "regionalatlas-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

/**
 * Options for {@link RequestEngine} and the client. The numeric options must be
 * integers within their documented range; anything else (negative, fractional,
 * NaN, Infinity, too large) makes the constructor throw a
 * RegionalatlasValidationError.
 */
export interface EngineOptions {
  /** Base URL of the ArcGIS data host. Defaults to the gis-idmz.nrw.de MapServer host. */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /** Value of the User-Agent header. */
  userAgent?: string;
  /** Extra headers sent on every request. */
  defaultHeaders?: Record<string, string>;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps (0 disables; at most MAX_TIMEOUT_MS, 2^31 - 1 ms).
   */
  timeoutMs?: number;
  /** Number of automatic retries for transient (429/503) responses, 0..`MAX_RETRIES` (10). */
  maxRetries?: number;
  /** Base backoff between retries in milliseconds (grows linearly), at most `MAX_RETRY_AFTER_MS`. */
  retryDelayMs?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   * At most `Number.MAX_SAFE_INTEGER`.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/**
 * True for the Unicode bidirectional formatting characters: ALM (U+061C), LRM/RLM
 * (U+200E/U+200F), the embeddings and overrides U+202A–U+202E and the isolates
 * U+2066–U+2069. A terminal applies them to the text that follows, so an override
 * in server text can reorder what the user sees ("Trojan Source" spoofing).
 */
export function isBidiControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Make a string that originates in a response — the ArcGIS `error` detail, the
 * non-JSON body snippet, and every text of the catalogue (titles, units, theme
 * names), which reach stderr in error messages — safe to print:
 *
 * - C0 and C1 controls and DEL are dropped. `JSON.parse` decodes an escaped ESC (a
 *   backslash-u-001b sequence) into a real ESC byte; printed raw, a hostile or
 *   MITM'd host could drive ANSI/OSC sequences into the terminal (screen clears,
 *   title changes, output spoofing).
 * - Bidi formatting characters (`isBidiControl`) are dropped, so server text cannot
 *   reorder the visible message.
 * - Every run of whitespace — newlines, tabs, U+2028/U+2029 included — becomes one
 *   space and the ends are trimmed, so the text stays on one line and cannot forge
 *   an `Error:` line of its own.
 *
 * The CLI's JSON output is escaped separately (`escapeControlChars` in
 * cli/shared.ts). Written as a char-code filter so no raw control byte appears in
 * this source.
 */
export function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    const whitespaceControl = n >= 0x09 && n <= 0x0d;
    if (!whitespaceControl && (n <= 0x1f || (n >= 0x7f && n <= 0x9f) || isBidiControl(n))) continue;
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * The human-readable text of an ArcGIS `error` value, for an error message: a bare
 * string as is, or an `{code, message, details}` object's `message` and `details`
 * joined with "; ". Empty parts and repeats are dropped (the server can send
 * `"message": ""` with the reason only in `details`, or the same text in both).
 * Every part goes through `sanitizeServerText`. Returns `undefined` when nothing
 * readable is left.
 */
export function describeArcGisError(error: unknown): string | undefined {
  let parts: unknown[] = [];
  if (typeof error === "string") parts = [error];
  else if (error !== null && typeof error === "object") {
    const e = error as { message?: unknown; details?: unknown };
    parts = [e.message, ...(Array.isArray(e.details) ? e.details : [])];
  }
  const seen = new Set<string>();
  for (const part of parts) {
    if (typeof part !== "string") continue;
    const text = sanitizeServerText(part);
    if (text !== "") seen.add(text);
  }
  return seen.size > 0 ? [...seen].join("; ") : undefined;
}

/** Most automatic retries a caller may ask for (the CLI's --max-retries shares it). */
export const MAX_RETRIES = 10;

/**
 * Read a numeric engine option: `undefined` gives the default; anything but an
 * integer in [0, max] throws. Without this a negative or NaN `timeoutMs` silently
 * disabled the timeout, and `maxResponseBytes: -5` the size cap.
 */
function intOption(name: string, value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new RegionalatlasValidationError(
      `Invalid option ${name}: expected an integer from 0 to ${max}, got ${String(value)}.`,
    );
  }
  return value;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Upper bound on a honoured `Retry-After`. The header is server-controlled, and a
 * `Retry-After: 86400` would otherwise park the CLI for a day, so a longer wait is
 * clamped to this.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header into a delay in milliseconds (RFC 9110 §10.2.3):
 * either delay-seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`,
 * turned into the time left from `now`; a date in the past gives 0).
 *
 * Returns `undefined` when the header is absent or malformed — negative (`"-5"`),
 * fractional (`"1.5"`), any other date format — so the caller falls back to linear
 * backoff. The strict patterns matter: `Date.parse` alone reads `"1.5"`, `"-5"` and
 * `"0.5"` as dates in 2000/2001 and so retried at once, in a burst.
 */
export function parseRetryAfter(
  header: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return undefined;
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

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
    throw new RegionalatlasNetworkError(`Invalid request URL: ${redactUrl(url)}`);
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
    // Request paths are appended to the base URL as a string, so a `?` or `#` in it
    // would swallow every path: `http://h/m?token=abc` requests
    // `/m?token=abc/arcgis/...` and `http://h/m#f` requests `/m` with no parameters.
    if (/[?#]/.test(this.baseUrl)) {
      throw new RegionalatlasNetworkError(
        `Base URL must not contain a query or fragment: ${redactUrl(this.baseUrl)}`,
      );
    }
    this.transport = options.transport ?? nodeHttpTransport;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, 30_000, MAX_TIMEOUT_MS);
    this.maxRetries = intOption("maxRetries", options.maxRetries, 2, MAX_RETRIES);
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, 200, MAX_RETRY_AFTER_MS);
    this.maxResponseBytes = intOption(
      "maxResponseBytes",
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      Number.MAX_SAFE_INTEGER,
    );
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
        // Honour a Retry-After header (delta-seconds or HTTP-date) when present,
        // clamped to MAX_RETRY_AFTER_MS; otherwise fall back to linear backoff.
        const retryAfter = parseRetryAfter(response.headers["retry-after"]);
        const delay =
          retryAfter !== undefined
            ? Math.min(retryAfter, MAX_RETRY_AFTER_MS)
            : this.retryDelayMs * attempt;
        await this.sleep(delay);
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
        error?: unknown;
        message?: unknown;
        detail?: unknown;
      };
      const arcgis = parsed?.error ? describeArcGisError(parsed.error) : undefined;
      if (arcgis !== undefined) detail = arcgis;
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
