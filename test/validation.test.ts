import { describe, expect, it } from "vitest";
import { rangeGroup, rangeStartDate } from "../app/lib/ranges";
import {
  isSupportedCode,
  isWellFormedCode,
  normalizeCode,
  validateRateQuery,
  validateSettings,
} from "../app/lib/validation";

const SUPPORTED = new Set(["USD", "EUR", "BTC", "XAU", "AAVE"]);

describe("currency code validation", () => {
  it("normalises case and whitespace", () => {
    expect(normalizeCode(" usd ")).toBe("USD");
    expect(normalizeCode(null)).toBe("");
    expect(normalizeCode(42)).toBe("");
  });

  it.each(["USD", "BTC", "AAVE", "1INCH"])("accepts well formed %s", (code) => {
    expect(isWellFormedCode(code)).toBe(true);
  });

  it.each(["", "U", "US$", "usd", "ABCDEFGHIJK", "USD;DROP", "../x"])(
    "rejects malformed %j",
    (code) => {
      expect(isWellFormedCode(code)).toBe(false);
    },
  );

  it("requires the code to be in the supported list", () => {
    expect(isSupportedCode("USD", SUPPORTED)).toBe(true);
    expect(isSupportedCode("GBP", SUPPORTED)).toBe(false);
  });
});

describe("validateRateQuery", () => {
  const query = (qs: string) =>
    validateRateQuery(new URLSearchParams(qs), SUPPORTED);

  it("accepts a valid pair and range", () => {
    expect(query("from=usd&to=EUR&range=1Y")).toEqual({
      ok: true,
      value: { from: "USD", to: "EUR", range: "1y" },
    });
  });

  it("defaults a missing range to 3m", () => {
    expect(query("from=USD&to=EUR")).toMatchObject({
      ok: true,
      value: { range: "3m" },
    });
  });

  it("allows the same currency on both sides", () => {
    expect(query("from=USD&to=USD").ok).toBe(true);
  });

  it.each([
    ["missing from", "to=EUR"],
    ["unsupported to", "from=USD&to=GBP"],
    ["malformed code", "from=US$&to=EUR"],
  ])("rejects %s", (_label, qs) => {
    expect(query(qs)).toEqual({ ok: false, message: "Unsupported currency." });
  });

  it("rejects an unknown range", () => {
    expect(query("from=USD&to=EUR&range=10y")).toEqual({
      ok: false,
      message: "Unsupported range.",
    });
  });
});

describe("validateSettings", () => {
  it("accepts an empty Default From", () => {
    expect(
      validateSettings(
        { defaultFrom: "", defaultTo: "eur", defaultRange: "6m" },
        SUPPORTED,
      ),
    ).toEqual({
      ok: true,
      value: { defaultFrom: "", defaultTo: "EUR", defaultRange: "6m" },
    });
  });

  it("rejects an unsupported Default From", () => {
    expect(
      validateSettings(
        { defaultFrom: "GBP", defaultTo: "EUR", defaultRange: "6m" },
        SUPPORTED,
      ).ok,
    ).toBe(false);
  });

  it("requires Default To", () => {
    expect(
      validateSettings(
        { defaultFrom: "USD", defaultTo: "", defaultRange: "6m" },
        SUPPORTED,
      ).ok,
    ).toBe(false);
  });

  it("rejects an unknown range", () => {
    expect(
      validateSettings(
        { defaultFrom: "USD", defaultTo: "EUR", defaultRange: "2w" },
        SUPPORTED,
      ).ok,
    ).toBe(false);
  });
});

describe("ranges", () => {
  const today = new Date("2026-11-20T23:30:00Z");

  it.each([
    ["1w", "2026-11-13"],
    ["1m", "2026-10-20"],
    ["3m", "2026-08-20"],
    ["6m", "2026-05-20"],
    ["1y", "2025-11-20"],
    ["5y", "2021-11-20"],
  ] as const)("%s starts on %s", (range, expected) => {
    expect(rangeStartDate(range, today)).toBe(expected);
  });

  it("clamps month steps to the end of a shorter month", () => {
    expect(rangeStartDate("1m", new Date("2026-03-31T00:00:00Z"))).toBe(
      "2026-02-28",
    );
    expect(rangeStartDate("1y", new Date("2028-02-29T00:00:00Z"))).toBe(
      "2027-02-28",
    );
  });

  it("groups 1Y weekly and 5Y monthly only", () => {
    expect(rangeGroup("1y")).toBe("week");
    expect(rangeGroup("5y")).toBe("month");
    expect(rangeGroup("6m")).toBeUndefined();
  });
});
