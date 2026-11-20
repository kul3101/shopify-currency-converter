import { describe, expect, it, vi } from "vitest";
import {
  createFrankfurterClient,
  FrankfurterError,
  optionsFromEnv,
  parseCurrencies,
  parseHistory,
} from "../app/lib/frankfurter.server";
import {
  CURRENCIES_BODY,
  jsonResponse,
  routedFetch,
  silentLogger,
} from "./helpers";

const TODAY = new Date("2026-11-20T12:00:00Z");

function setup(overrides: Parameters<typeof createFrankfurterClient>[0] = {}) {
  let clock = TODAY.getTime();
  const logger = silentLogger();
  const fetch = routedFetch({
    currencies: () => jsonResponse(CURRENCIES_BODY),
    "rate/": (url) => {
      const [, , base, quote] = url.pathname.split("/").slice(1);
      return jsonResponse({ date: "2026-11-20", base, quote, rate: 0.91 });
    },
    rates: () =>
      jsonResponse([
        { date: "2026-11-19", base: "USD", quote: "EUR", rate: 0.9 },
        { date: "2026-11-18", base: "USD", quote: "EUR", rate: 0.89 },
        { date: "2026-11-18", base: "USD", quote: "GBP", rate: 0.77 },
        { date: "2026-11-17", base: "USD", quote: "EUR", rate: "bad" },
      ]),
  });
  const client = createFrankfurterClient({
    fetch,
    logger,
    now: () => clock,
    ...overrides,
  });
  return {
    client,
    fetch,
    logger,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("Frankfurter client", () => {
  describe("requests", () => {
    it("normalises and sorts the currency list", async () => {
      const { client, fetch } = setup();

      const currencies = await client.getCurrencies();

      expect(currencies.map((c) => c.code)).toEqual([
        "BTC",
        "EUR",
        "USD",
        "XAU",
      ]);
      expect(currencies.find((c) => c.code === "XAU")?.type).toBe("metal");
      expect(String(fetch.mock.calls[0][0])).toBe(
        "https://api.frankfurter.dev/v2/currencies",
      );
    });

    it("returns the latest rate for a pair", async () => {
      const { client, fetch } = setup();

      await expect(client.getLatestRate("USD", "EUR")).resolves.toEqual({
        date: "2026-11-20",
        rate: 0.91,
      });
      expect(String(fetch.mock.calls[0][0])).toBe(
        "https://api.frankfurter.dev/v2/rate/USD/EUR",
      );
    });

    it("builds history queries with start date and group", async () => {
      const { client, fetch } = setup();

      await client.getHistory("USD", "EUR", "1y", TODAY);
      await client.getHistory("USD", "EUR", "5y", TODAY);
      await client.getHistory("USD", "EUR", "1m", TODAY);

      const urls = fetch.mock.calls.map(([input]) => new URL(String(input)));
      expect(Object.fromEntries(urls[0].searchParams)).toEqual({
        base: "USD",
        quotes: "EUR",
        from: "2025-11-20",
        group: "week",
      });
      expect(urls[1].searchParams.get("group")).toBe("month");
      expect(urls[1].searchParams.get("from")).toBe("2021-11-20");
      expect(urls[2].searchParams.has("group")).toBe(false);
      expect(urls[2].searchParams.get("from")).toBe("2026-10-20");
    });

    it("keeps only valid points for the quote, oldest first", async () => {
      const { client } = setup();

      await expect(
        client.getHistory("USD", "EUR", "1w", TODAY),
      ).resolves.toEqual([
        { date: "2026-11-18", rate: 0.89 },
        { date: "2026-11-19", rate: 0.9 },
      ]);
    });

    it("honours a custom base URL without a trailing slash", async () => {
      const { client, fetch } = setup({
        baseUrl: "https://rates.example.test/v2",
      });

      await client.getCurrencies();

      expect(String(fetch.mock.calls[0][0])).toBe(
        "https://rates.example.test/v2/currencies",
      );
    });
  });

  describe("caching", () => {
    it("serves the currency list from cache for 24 hours", async () => {
      const { client, fetch, advance } = setup({ rateTtlSeconds: 60 });

      await client.getCurrencies();
      advance(23 * 3600 * 1000);
      await client.getCurrencies();
      expect(fetch).toHaveBeenCalledTimes(1);

      advance(2 * 3600 * 1000);
      await client.getCurrencies();
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("caches rates for the configured lifetime", async () => {
      const { client, fetch, advance } = setup({ rateTtlSeconds: 3600 });

      await client.getLatestRate("USD", "EUR");
      advance(3599 * 1000);
      await client.getLatestRate("USD", "EUR");
      expect(fetch).toHaveBeenCalledTimes(1);

      advance(2 * 1000);
      await client.getLatestRate("USD", "EUR");
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("does not cache rates when the lifetime is 0", async () => {
      const { client, fetch } = setup({ rateTtlSeconds: 0 });

      await client.getLatestRate("USD", "EUR");
      await client.getLatestRate("USD", "EUR");

      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("caches each pair separately", async () => {
      const { client, fetch } = setup();

      await client.getLatestRate("USD", "EUR");
      await client.getLatestRate("EUR", "USD");

      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("never caches a failed response", async () => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ message: "boom" }, 500))
        .mockResolvedValueOnce(jsonResponse({ date: "2026-11-20", rate: 0.9 }));
      const client = createFrankfurterClient({ fetch, logger: silentLogger() });

      await expect(client.getLatestRate("USD", "EUR")).rejects.toThrow(
        FrankfurterError,
      );
      await expect(client.getLatestRate("USD", "EUR")).resolves.toEqual({
        date: "2026-11-20",
        rate: 0.9,
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("never caches a 200 response with an unusable body", async () => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ date: "2026-11-20" }))
        .mockResolvedValueOnce(jsonResponse({ date: "2026-11-20", rate: 0.9 }));
      const client = createFrankfurterClient({ fetch, logger: silentLogger() });

      await expect(client.getLatestRate("USD", "EUR")).rejects.toMatchObject({
        kind: "invalid_response",
      });
      await expect(client.getLatestRate("USD", "EUR")).resolves.toMatchObject({
        rate: 0.9,
      });
    });

    it("shares one upstream request between concurrent callers", async () => {
      const { client, fetch } = setup();

      await Promise.all([client.getCurrencies(), client.getCurrencies()]);

      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("evicts the least recently used entry when full", async () => {
      const { client, fetch } = setup({ maxCacheEntries: 2 });

      await client.getLatestRate("USD", "EUR");
      await client.getLatestRate("USD", "GBP");
      await client.getLatestRate("USD", "EUR");
      await client.getLatestRate("USD", "JPY");
      await client.getLatestRate("USD", "EUR");
      expect(fetch).toHaveBeenCalledTimes(3);

      await client.getLatestRate("USD", "GBP");
      expect(fetch).toHaveBeenCalledTimes(4);
    });
  });

  describe("error mapping and logging", () => {
    it("maps HTTP errors and logs the upstream message", async () => {
      const logger = silentLogger();
      const fetch = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ status: 422, message: "invalid currency: XXX" }, 422),
        );
      const client = createFrankfurterClient({ fetch, logger });

      const error = await client
        .getLatestRate("USD", "XXX")
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(FrankfurterError);
      expect(error).toMatchObject({ kind: "http", status: 422 });
      expect(logger.warn).toHaveBeenCalledWith(
        "Upstream returned an error",
        expect.objectContaining({
          status: 422,
          message: "invalid currency: XXX",
        }),
      );
    });

    it("maps transport failures to network errors", async () => {
      const logger = silentLogger();
      const fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
      const client = createFrankfurterClient({ fetch, logger });

      await expect(client.getCurrencies()).rejects.toMatchObject({
        kind: "network",
      });
      expect(logger.error).toHaveBeenCalledWith(
        "Request failed",
        expect.objectContaining({ error: "TypeError: fetch failed" }),
      );
    });

    it("times out slow requests", async () => {
      const logger = silentLogger();
      const fetch = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            );
          }),
      );
      const client = createFrankfurterClient({ fetch, logger, timeoutMs: 20 });

      await expect(client.getCurrencies()).rejects.toMatchObject({
        kind: "timeout",
      });
      expect(logger.error).toHaveBeenCalledWith(
        "Request timed out",
        expect.objectContaining({ timeoutMs: 20 }),
      );
    });

    it("maps a non-JSON body to invalid_response", async () => {
      const fetch = vi
        .fn()
        .mockResolvedValue(new Response("<html>oops</html>", { status: 200 }));
      const client = createFrankfurterClient({ fetch, logger: silentLogger() });

      await expect(client.getCurrencies()).rejects.toMatchObject({
        kind: "invalid_response",
      });
    });

    it("rejects an empty currency list", async () => {
      const fetch = vi.fn().mockResolvedValue(jsonResponse([]));
      const client = createFrankfurterClient({ fetch, logger: silentLogger() });

      await expect(client.getCurrencies()).rejects.toMatchObject({
        kind: "invalid_response",
      });
    });
  });

  describe("parsers", () => {
    it("drops rows without a code and defaults unknown types", () => {
      expect(
        parseCurrencies([
          { iso_code: "usd", name: "US Dollar" },
          { name: "No code" },
          { iso_code: "ZZZ", type: "unknown" },
        ]),
      ).toEqual([
        { code: "USD", name: "US Dollar", symbol: "", type: "currency" },
        { code: "ZZZ", name: "ZZZ", symbol: "", type: "currency" },
      ]);
    });

    it("rejects a history body that is not an array", () => {
      expect(() => parseHistory({ message: "nope" }, "EUR")).toThrow();
    });
  });

  describe("optionsFromEnv", () => {
    it("uses defaults when nothing is set", () => {
      expect(optionsFromEnv({})).toEqual({
        baseUrl: "https://api.frankfurter.dev/v2/",
        timeoutMs: 10000,
        rateTtlSeconds: 3600,
      });
    });

    it("reads overrides and ignores invalid values", () => {
      expect(
        optionsFromEnv({
          FRANKFURTER_BASE_URL: "https://mirror.test/v2/",
          FRANKFURTER_TIMEOUT_MS: "2500",
          FRANKFURTER_RATE_CACHE_TTL: "0",
        }),
      ).toEqual({
        baseUrl: "https://mirror.test/v2/",
        timeoutMs: 2500,
        rateTtlSeconds: 0,
      });
      expect(optionsFromEnv({ FRANKFURTER_TIMEOUT_MS: "-5" }).timeoutMs).toBe(
        10000,
      );
      expect(
        optionsFromEnv({ FRANKFURTER_RATE_CACHE_TTL: "abc" }).rateTtlSeconds,
      ).toBe(3600);
    });
  });
});
