import { rangeGroup, rangeStartDate, type HistoryRange } from "./ranges";

export const DEFAULT_BASE_URL = "https://api.frankfurter.dev/v2/";
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_RATE_TTL_SECONDS = 3_600;
export const CURRENCIES_TTL_SECONDS = 86_400;
const DEFAULT_MAX_CACHE_ENTRIES = 1_000;
const USER_AGENT = "Shopify-CurrencyConverter/1.0";

export type FrankfurterErrorKind =
  "timeout" | "network" | "http" | "invalid_response";

/**
 * Raised for every upstream failure. The message is for logs only; callers
 * must show shoppers a fixed message instead.
 */
export class FrankfurterError extends Error {
  readonly kind: FrankfurterErrorKind;
  readonly status?: number;

  constructor(
    kind: FrankfurterErrorKind,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "FrankfurterError";
    this.kind = kind;
    this.status = options.status;
  }
}

export interface Logger {
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export type CurrencyType = "currency" | "metal" | "crypto";

export interface Currency {
  code: string;
  name: string;
  symbol: string;
  type: CurrencyType;
}

export interface RatePoint {
  date: string;
  rate: number;
}

export interface FrankfurterClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** Seconds to cache latest rates and history. 0 disables caching. */
  rateTtlSeconds?: number;
  /** Seconds to cache the currency list. 0 disables caching. */
  currenciesTtlSeconds?: number;
  maxCacheEntries?: number;
  fetch?: typeof fetch;
  logger?: Logger;
  now?: () => number;
}

export interface FrankfurterClient {
  getCurrencies(): Promise<Currency[]>;
  getSupportedCodes(): Promise<Set<string>>;
  getLatestRate(from: string, to: string): Promise<RatePoint>;
  getHistory(
    from: string,
    to: string,
    range: HistoryRange,
    today?: Date,
  ): Promise<RatePoint[]>;
  clearCache(): void;
}

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

const consoleLogger: Logger = {
  warn: (message, context) =>
    console.warn(`[frankfurter] ${message}`, context ?? {}),
  error: (message, context) =>
    console.error(`[frankfurter] ${message}`, context ?? {}),
};

export function createFrankfurterClient(
  options: FrankfurterClientOptions = {},
): FrankfurterClient {
  const baseUrl = withTrailingSlash(options.baseUrl ?? DEFAULT_BASE_URL);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const rateTtl = options.rateTtlSeconds ?? DEFAULT_RATE_TTL_SECONDS;
  const currenciesTtl = options.currenciesTtlSeconds ?? CURRENCIES_TTL_SECONDS;
  const maxEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const logger = options.logger ?? consoleLogger;
  const now = options.now ?? Date.now;

  // Map keeps insertion order, so the first key is the least recently used.
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<unknown>>();

  function readCache<T>(key: string): T | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      cache.delete(key);
      return undefined;
    }
    cache.delete(key);
    cache.set(key, entry);
    return entry.value as T;
  }

  function writeCache(key: string, value: unknown, ttlSeconds: number) {
    if (ttlSeconds <= 0) return;
    cache.delete(key);
    cache.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  /**
   * GET a path, parse it with `parse`, and cache the parsed value. Parsing
   * runs before caching, so only successful, well-formed responses are
   * stored. Concurrent calls for the same URL share one upstream request.
   */
  async function get<T>(
    path: string,
    query: Record<string, string | undefined>,
    ttlSeconds: number,
    parse: (body: unknown) => T,
  ): Promise<T> {
    const url = buildUrl(baseUrl, path, query);
    const cached = readCache<T>(url);
    if (cached !== undefined) return cached;

    const pending = inFlight.get(url) as Promise<T> | undefined;
    if (pending) return pending;

    const request = (async () => {
      const body = await requestJson(url);
      let value: T;
      try {
        value = parse(body);
      } catch (error) {
        logger.error("Unexpected response shape", {
          url,
          error: describe(error),
        });
        throw new FrankfurterError(
          "invalid_response",
          "Unexpected response shape",
          {
            cause: error,
          },
        );
      }
      writeCache(url, value, ttlSeconds);
      return value;
    })();

    inFlight.set(url, request);
    try {
      return await request;
    } finally {
      inFlight.delete(url);
    }
  }

  async function requestJson(url: string): Promise<unknown> {
    const startedAt = now();
    let response: Response;
    try {
      response = await doFetch(url, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = isAbortError(error);
      logger.error(timedOut ? "Request timed out" : "Request failed", {
        url,
        timeoutMs,
        durationMs: now() - startedAt,
        error: describe(error),
      });
      throw new FrankfurterError(
        timedOut ? "timeout" : "network",
        timedOut ? `Timed out after ${timeoutMs}ms` : "Network error",
        { cause: error },
      );
    }

    const text = await response.text().catch(() => "");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }

    if (!response.ok) {
      logger.warn("Upstream returned an error", {
        url,
        status: response.status,
        message: isRecord(body) ? body.message : undefined,
        durationMs: now() - startedAt,
      });
      throw new FrankfurterError("http", `HTTP ${response.status}`, {
        status: response.status,
      });
    }

    if (body === undefined) {
      logger.error("Upstream returned a non-JSON body", {
        url,
        status: response.status,
      });
      throw new FrankfurterError("invalid_response", "Non-JSON body", {
        status: response.status,
      });
    }

    return body;
  }

  async function getCurrencies(): Promise<Currency[]> {
    return get("currencies", {}, currenciesTtl, parseCurrencies);
  }

  return {
    getCurrencies,
    async getSupportedCodes() {
      return new Set((await getCurrencies()).map((currency) => currency.code));
    },
    getLatestRate(from, to) {
      return get(
        `rate/${encodeURIComponent(from)}/${encodeURIComponent(to)}`,
        {},
        rateTtl,
        parseLatestRate,
      );
    },
    getHistory(from, to, range, today = new Date(now())) {
      return get(
        "rates",
        {
          base: from,
          quotes: to,
          from: rangeStartDate(range, today),
          group: rangeGroup(range),
        },
        rateTtl,
        (body) => parseHistory(body, to),
      );
    },
    clearCache() {
      cache.clear();
    },
  };
}

export function parseCurrencies(body: unknown): Currency[] {
  if (!Array.isArray(body)) throw new Error("Expected an array of currencies");

  const byCode = new Map<string, Currency>();
  for (const row of body) {
    if (!isRecord(row) || typeof row.iso_code !== "string") continue;
    const code = row.iso_code.trim().toUpperCase();
    if (code === "") continue;
    byCode.set(code, {
      code,
      name: typeof row.name === "string" && row.name !== "" ? row.name : code,
      symbol: typeof row.symbol === "string" ? row.symbol : "",
      type:
        row.type === "metal" || row.type === "crypto" ? row.type : "currency",
    });
  }

  if (byCode.size === 0) throw new Error("No currencies in response");

  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
}

export function parseLatestRate(body: unknown): RatePoint {
  const point = toRatePoint(body);
  if (!point) throw new Error("Missing or invalid rate");
  return point;
}

export function parseHistory(body: unknown, quote: string): RatePoint[] {
  if (!Array.isArray(body)) throw new Error("Expected an array of rates");

  return body
    .filter((row) => isRecord(row) && row.quote === quote)
    .map(toRatePoint)
    .filter((point): point is RatePoint => point !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function toRatePoint(row: unknown): RatePoint | null {
  if (!isRecord(row)) return null;
  const rate = typeof row.rate === "number" ? row.rate : Number(row.rate);
  if (typeof row.date !== "string" || !Number.isFinite(rate) || rate <= 0) {
    return null;
  }
  return { date: row.date, rate };
}

function buildUrl(
  baseUrl: string,
  path: string,
  query: Record<string, string | undefined>,
): string {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

function withTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function intFromEnv(value: string | undefined, fallback: number, min: number) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

/**
 * Read client settings from the environment:
 * FRANKFURTER_BASE_URL, FRANKFURTER_TIMEOUT_MS and FRANKFURTER_RATE_CACHE_TTL
 * (seconds, 0 disables rate caching).
 */
export function optionsFromEnv(
  env: Record<string, string | undefined>,
): FrankfurterClientOptions {
  return {
    baseUrl: env.FRANKFURTER_BASE_URL?.trim() || DEFAULT_BASE_URL,
    timeoutMs: intFromEnv(env.FRANKFURTER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1),
    rateTtlSeconds: intFromEnv(
      env.FRANKFURTER_RATE_CACHE_TTL,
      DEFAULT_RATE_TTL_SECONDS,
      0,
    ),
  };
}

let sharedClient: FrankfurterClient | undefined;

/** Process-wide client, so every request shares one cache. */
export function getFrankfurterClient(): FrankfurterClient {
  sharedClient ??= createFrankfurterClient(optionsFromEnv(process.env));
  return sharedClient;
}
