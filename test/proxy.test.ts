import { createHmac } from "node:crypto";
import "@shopify/shopify-api/adapters/node";
import { ApiVersion, shopifyApi } from "@shopify/shopify-api";
import { describe, expect, it, vi } from "vitest";
import { createFrankfurterClient } from "../app/lib/frankfurter.server";
import {
  handleCurrencies,
  handleRate,
  INVALID_SIGNATURE_MESSAGE,
  UNAVAILABLE_MESSAGE,
  type ProxyDeps,
} from "../app/lib/proxy.server";
import {
  CURRENCIES_BODY,
  jsonResponse,
  routedFetch,
  silentLogger,
} from "./helpers";

const SECRET = "test-shared-secret";
const APP_URL = "https://app.example.test";

const api = shopifyApi({
  apiKey: "test-key",
  apiSecretKey: SECRET,
  apiVersion: ApiVersion.July26,
  hostName: "app.example.test",
  isEmbeddedApp: true,
  logger: { log: () => undefined },
});

/** Same check the app performs through authenticate.public.appProxy. */
async function verify(request: Request) {
  const valid = await api.utils.validateHmac(
    new URL(request.url).searchParams,
    {
      signator: "appProxy",
    },
  );
  if (!valid) throw new Response(undefined, { status: 400 });
}

/**
 * Sign the way Shopify does: sort the parameters, join each as key=value with
 * no separator, and HMAC-SHA256 the result with the app secret.
 */
function signedRequest(
  path: string,
  params: Record<string, string>,
  secret = SECRET,
) {
  const all: Record<string, string> = {
    shop: "demo.myshopify.com",
    path_prefix: "/apps/currency-converter",
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...params,
  };
  const message = Object.keys(all)
    .sort()
    .map((key) => `${key}=${all[key]}`)
    .join("");
  const signature = createHmac("sha256", secret).update(message).digest("hex");
  const url = new URL(`/proxy/${path}`, APP_URL);
  for (const [key, value] of Object.entries({ ...all, signature })) {
    url.searchParams.set(key, value);
  }
  return new Request(url);
}

function deps(fetch = upstream()): ProxyDeps & { fetch: typeof fetch } {
  return {
    verify,
    fetch,
    logger: silentLogger(),
    client: createFrankfurterClient({ fetch, logger: silentLogger() }),
  };
}

function upstream() {
  return routedFetch({
    currencies: () => jsonResponse(CURRENCIES_BODY),
    "rate/": () =>
      jsonResponse({
        date: "2026-11-20",
        base: "USD",
        quote: "EUR",
        rate: 0.91,
      }),
    rates: () =>
      jsonResponse([
        { date: "2026-11-18", base: "USD", quote: "EUR", rate: 0.9 },
        { date: "2026-11-19", base: "USD", quote: "EUR", rate: 0.905 },
      ]),
  });
}

describe("app proxy: /rate", () => {
  it("returns the rate and history for a valid signed request", async () => {
    const d = deps();

    const response = await handleRate(
      signedRequest("rate", { from: "usd", to: "EUR", range: "1m" }),
      d,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(await response.json()).toEqual({
      from: "USD",
      to: "EUR",
      range: "1m",
      rate: 0.91,
      date: "2026-11-20",
      history: [
        { date: "2026-11-18", rate: 0.9 },
        { date: "2026-11-19", rate: 0.905 },
      ],
    });
  });

  it("rejects a request without a signature", async () => {
    const d = deps();
    const request = new Request(
      `${APP_URL}/proxy/rate?from=USD&to=EUR&shop=demo.myshopify.com`,
    );

    const response = await handleRate(request, d);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: INVALID_SIGNATURE_MESSAGE });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("rejects a request signed with the wrong secret", async () => {
    const response = await handleRate(
      signedRequest("rate", { from: "USD", to: "EUR" }, "wrong-secret"),
      deps(),
    );

    expect(response.status).toBe(401);
  });

  it("rejects a request whose parameters were changed after signing", async () => {
    const request = signedRequest("rate", { from: "USD", to: "EUR" });
    const tampered = new URL(request.url);
    tampered.searchParams.set("to", "BTC");

    const response = await handleRate(new Request(tampered), deps());

    expect(response.status).toBe(401);
  });

  it("returns 400 for a currency that is not supported", async () => {
    const d = deps();

    const response = await handleRate(
      signedRequest("rate", { from: "USD", to: "GBP" }),
      d,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Unsupported currency." });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const calledPaths = d.fetch.mock.calls.map(
      ([input]) => new URL(String(input)).pathname,
    );
    expect(calledPaths).toEqual(["/v2/currencies"]);
  });

  it("returns 400 for a malformed code", async () => {
    const response = await handleRate(
      signedRequest("rate", { from: "<script>", to: "EUR" }),
      deps(),
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 for an unknown range", async () => {
    const response = await handleRate(
      signedRequest("rate", { from: "USD", to: "EUR", range: "99y" }),
      deps(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Unsupported range." });
  });

  it("returns 503 with a fixed message when the rate call fails", async () => {
    const fetch = routedFetch({
      currencies: () => jsonResponse(CURRENCIES_BODY),
      "rate/": () => jsonResponse({ message: "secret upstream detail" }, 500),
      rates: () => jsonResponse([]),
    });

    const response = await handleRate(
      signedRequest("rate", { from: "USD", to: "EUR" }),
      deps(fetch),
    );
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toEqual({ error: UNAVAILABLE_MESSAGE });
    expect(text).not.toContain("secret upstream detail");
    expect(text).not.toContain("500");
  });

  it("returns 503 when the currency list cannot be loaded", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValue(
        new Error("getaddrinfo ENOTFOUND api.frankfurter.dev"),
      );

    const response = await handleRate(
      signedRequest("rate", { from: "USD", to: "EUR" }),
      deps(fetch),
    );
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(text).not.toContain("ENOTFOUND");
  });

  it("returns 503 and logs when something unexpected throws", async () => {
    const d = deps();
    d.client.getHistory = vi.fn().mockRejectedValue(new Error("bug"));

    const response = await handleRate(
      signedRequest("rate", { from: "USD", to: "EUR" }),
      d,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: UNAVAILABLE_MESSAGE });
    expect(d.logger?.error).toHaveBeenCalledWith(
      "Unexpected proxy error",
      expect.objectContaining({ endpoint: "rate", error: "bug" }),
    );
  });
});

describe("app proxy: /currencies", () => {
  it("returns the supported currencies for a signed request", async () => {
    const response = await handleCurrencies(
      signedRequest("currencies", {}),
      deps(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
    const body = await response.json();
    expect(body.currencies.map((c: { code: string }) => c.code)).toEqual([
      "BTC",
      "EUR",
      "USD",
      "XAU",
    ]);
  });

  it("rejects an unsigned request", async () => {
    const response = await handleCurrencies(
      new Request(`${APP_URL}/proxy/currencies`),
      deps(),
    );

    expect(response.status).toBe(401);
  });

  it("returns 503 with a fixed message on upstream failure", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: "maintenance" }, 502));

    const response = await handleCurrencies(
      signedRequest("currencies", {}),
      deps(fetch),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: UNAVAILABLE_MESSAGE });
  });
});
