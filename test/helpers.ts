import { vi } from "vitest";
import type { Logger } from "../app/lib/frankfurter.server";

export const CURRENCIES_BODY = [
  { iso_code: "USD", name: "US Dollar", symbol: "$", type: "currency" },
  { iso_code: "EUR", name: "Euro", symbol: "€", type: "currency" },
  { iso_code: "XAU", name: "Gold", symbol: "XAU", type: "metal" },
  { iso_code: "BTC", name: "Bitcoin", symbol: "₿", type: "crypto" },
];

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function silentLogger(): Logger & {
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return { warn: vi.fn(), error: vi.fn() };
}

/**
 * Fake fetch that routes by URL path. Each route returns a Response, or
 * throws to simulate a transport failure.
 */
export function routedFetch(routes: Record<string, (url: URL) => Response>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v2\//, "");
    const handler =
      routes[path] ??
      Object.entries(routes).find(([prefix]) => path.startsWith(prefix))?.[1];
    if (!handler) throw new Error(`No fake route for ${path}`);
    return handler(url);
  });
}
