export const HISTORY_RANGES = ["1w", "1m", "3m", "6m", "1y", "5y"] as const;

export type HistoryRange = (typeof HISTORY_RANGES)[number];

export type HistoryGroup = "week" | "month";

export const DEFAULT_RANGE: HistoryRange = "3m";

export const RANGE_LABELS: Record<HistoryRange, string> = {
  "1w": "1W",
  "1m": "1M",
  "3m": "3M",
  "6m": "6M",
  "1y": "1Y",
  "5y": "5Y",
};

export function isHistoryRange(value: unknown): value is HistoryRange {
  return (
    typeof value === "string" &&
    (HISTORY_RANGES as readonly string[]).includes(value)
  );
}

/**
 * Long ranges are down-sampled through Frankfurter's `group` parameter so the
 * chart stays readable: 1Y uses weekly points and 5Y uses monthly points.
 */
export function rangeGroup(range: HistoryRange): HistoryGroup | undefined {
  if (range === "1y") return "week";
  if (range === "5y") return "month";
  return undefined;
}

/**
 * First day of the range in UTC, counted back from `today`, as YYYY-MM-DD.
 * Month and year steps clamp to the last day of the target month, so
 * 31 March minus one month is 28 or 29 February, never 3 March.
 */
export function rangeStartDate(range: HistoryRange, today: Date): string {
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  const day = today.getUTCDate();

  if (range === "1w") {
    return isoDate(new Date(Date.UTC(year, month, day - 7)));
  }

  const monthsBack = { "1m": 1, "3m": 3, "6m": 6, "1y": 12, "5y": 60 }[range];
  const target = new Date(Date.UTC(year, month - monthsBack, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));

  return isoDate(target);
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
