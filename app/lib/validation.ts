import { DEFAULT_RANGE, isHistoryRange, type HistoryRange } from "./ranges";

/** Frankfurter codes are ISO 4217 plus crypto tickers such as BTC or AAVE. */
const CODE_PATTERN = /^[A-Z0-9]{2,10}$/;

export function normalizeCode(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

export function isWellFormedCode(code: string): boolean {
  return CODE_PATTERN.test(code);
}

/** True when the code is well formed and in the supported list. */
export function isSupportedCode(
  code: string,
  supported: ReadonlySet<string>,
): boolean {
  return isWellFormedCode(code) && supported.has(code);
}

export interface RateQuery {
  from: string;
  to: string;
  range: HistoryRange;
}

export type ValidationResult<T> =
  { ok: true; value: T } | { ok: false; message: string };

/**
 * Validate `from`, `to` and `range` query parameters. Codes must be in the
 * supported list; a missing range falls back to the default, but a range that
 * is present and unknown is rejected so typos surface instead of silently
 * returning a different chart.
 */
export function validateRateQuery(
  params: URLSearchParams,
  supported: ReadonlySet<string>,
): ValidationResult<RateQuery> {
  const from = normalizeCode(params.get("from"));
  const to = normalizeCode(params.get("to"));
  const rawRange = params.get("range");

  if (!isSupportedCode(from, supported) || !isSupportedCode(to, supported)) {
    return { ok: false, message: "Unsupported currency." };
  }

  if (rawRange === null || rawRange === "") {
    return { ok: true, value: { from, to, range: DEFAULT_RANGE } };
  }

  const range = rawRange.trim().toLowerCase();
  if (!isHistoryRange(range)) {
    return { ok: false, message: "Unsupported range." };
  }

  return { ok: true, value: { from, to, range } };
}

export interface ConverterSettings {
  /** Empty string means "use the shopper's current store currency". */
  defaultFrom: string;
  defaultTo: string;
  defaultRange: HistoryRange;
}

/**
 * Validate settings submitted from the admin page. `defaultFrom` may be empty;
 * `defaultTo` is required. Both must be in the supported list when present.
 */
export function validateSettings(
  input: { defaultFrom?: unknown; defaultTo?: unknown; defaultRange?: unknown },
  supported: ReadonlySet<string>,
): ValidationResult<ConverterSettings> {
  const defaultFrom = normalizeCode(input.defaultFrom);
  const defaultTo = normalizeCode(input.defaultTo);
  const defaultRange =
    typeof input.defaultRange === "string"
      ? input.defaultRange.trim().toLowerCase()
      : "";

  if (defaultFrom !== "" && !isSupportedCode(defaultFrom, supported)) {
    return { ok: false, message: "Default From is not a supported currency." };
  }
  if (!isSupportedCode(defaultTo, supported)) {
    return { ok: false, message: "Default To is not a supported currency." };
  }
  if (!isHistoryRange(defaultRange)) {
    return { ok: false, message: "Default range is not valid." };
  }

  return { ok: true, value: { defaultFrom, defaultTo, defaultRange } };
}
