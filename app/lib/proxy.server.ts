import type { FrankfurterClient, Logger } from "./frankfurter.server";
import { FrankfurterError } from "./frankfurter.server";
import { validateRateQuery } from "./validation";

/** Shown to shoppers for every upstream failure; upstream details stay in the logs. */
export const UNAVAILABLE_MESSAGE =
  "Unable to load the exchange rate. Please try again later.";
export const INVALID_SIGNATURE_MESSAGE = "Invalid request signature.";

const CURRENCIES_MAX_AGE = 3_600;
const RATE_MAX_AGE = 300;

export interface ProxyDeps {
  /** Resolves when the app proxy signature is valid; rejects otherwise. */
  verify(request: Request): Promise<void>;
  client: FrankfurterClient;
  logger?: Logger;
}

/** GET /apps/currency-converter/currencies */
export async function handleCurrencies(
  request: Request,
  deps: ProxyDeps,
): Promise<Response> {
  const denied = await checkSignature(request, deps);
  if (denied) return denied;

  try {
    const currencies = await deps.client.getCurrencies();
    return json({ currencies }, 200, CURRENCIES_MAX_AGE);
  } catch (error) {
    return unavailable(error, deps, "currencies");
  }
}

/** GET /apps/currency-converter/rate?from=USD&to=EUR&range=3m */
export async function handleRate(
  request: Request,
  deps: ProxyDeps,
): Promise<Response> {
  const denied = await checkSignature(request, deps);
  if (denied) return denied;

  const params = new URL(request.url).searchParams;

  try {
    const supported = await deps.client.getSupportedCodes();
    const query = validateRateQuery(params, supported);
    if (!query.ok) return json({ error: query.message }, 400);

    const { from, to, range } = query.value;
    const [latest, history] = await Promise.all([
      deps.client.getLatestRate(from, to),
      deps.client.getHistory(from, to, range),
    ]);

    return json(
      { from, to, range, rate: latest.rate, date: latest.date, history },
      200,
      RATE_MAX_AGE,
    );
  } catch (error) {
    return unavailable(error, deps, "rate");
  }
}

async function checkSignature(
  request: Request,
  deps: ProxyDeps,
): Promise<Response | null> {
  try {
    await deps.verify(request);
    return null;
  } catch {
    return json({ error: INVALID_SIGNATURE_MESSAGE }, 401);
  }
}

function unavailable(
  error: unknown,
  deps: ProxyDeps,
  endpoint: string,
): Response {
  // FrankfurterError is already logged by the client with full context.
  if (!(error instanceof FrankfurterError)) {
    (deps.logger ?? console).error("Unexpected proxy error", {
      endpoint,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return json({ error: UNAVAILABLE_MESSAGE }, 503);
}

function json(body: unknown, status: number, maxAge?: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control":
        maxAge !== undefined ? `public, max-age=${maxAge}` : "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
