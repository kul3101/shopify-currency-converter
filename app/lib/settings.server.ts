import { DEFAULT_RANGE, isHistoryRange } from "./ranges";
import type { ConverterSettings } from "./validation";

/**
 * Settings live in app-owned shop metafields (namespace `$app`, declared in
 * shopify.app.toml). The theme block reads them in Liquid through
 * `shop.metafields["$app"]`, so the storefront needs no extra request.
 */
export const SETTINGS_KEYS = {
  defaultFrom: "default_from",
  defaultTo: "default_to",
  defaultRange: "default_range",
} as const;

export const DEFAULT_SETTINGS: ConverterSettings = {
  defaultFrom: "",
  defaultTo: "USD",
  defaultRange: DEFAULT_RANGE,
};

export type AdminGraphql = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

const SETTINGS_QUERY = `#graphql
  query CurrencyConverterSettings {
    shop {
      id
      currencyCode
      defaultFrom: metafield(namespace: "$app", key: "default_from") { value }
      defaultTo: metafield(namespace: "$app", key: "default_to") { value }
      defaultRange: metafield(namespace: "$app", key: "default_range") { value }
    }
  }`;

const SET_MUTATION = `#graphql
  mutation SetCurrencyConverterSettings($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message code }
    }
  }`;

const DELETE_MUTATION = `#graphql
  mutation DeleteCurrencyConverterSettings($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      userErrors { field message }
    }
  }`;

interface MetafieldValue {
  value?: string | null;
}

interface SettingsQueryData {
  shop: {
    id: string;
    currencyCode: string;
    defaultFrom: MetafieldValue | null;
    defaultTo: MetafieldValue | null;
    defaultRange: MetafieldValue | null;
  };
}

interface UserError {
  message: string;
}

export interface StoredSettings {
  shopId: string;
  shopCurrency: string;
  settings: ConverterSettings;
}

export async function loadSettings(
  graphql: AdminGraphql,
): Promise<StoredSettings> {
  const data = await run<SettingsQueryData>(graphql, SETTINGS_QUERY);
  const { shop } = data;
  const range = shop.defaultRange?.value ?? "";

  return {
    shopId: shop.id,
    shopCurrency: shop.currencyCode,
    settings: {
      defaultFrom: shop.defaultFrom?.value ?? DEFAULT_SETTINGS.defaultFrom,
      defaultTo: shop.defaultTo?.value || DEFAULT_SETTINGS.defaultTo,
      defaultRange: isHistoryRange(range)
        ? range
        : DEFAULT_SETTINGS.defaultRange,
    },
  };
}

/**
 * Write validated settings. An empty Default From deletes the metafield, so
 * the block falls back to the shopper's current currency.
 */
export async function saveSettings(
  graphql: AdminGraphql,
  shopId: string,
  settings: ConverterSettings,
): Promise<string[]> {
  const field = (key: string, value: string) => ({
    ownerId: shopId,
    namespace: "$app",
    key,
    type: "single_line_text_field",
    value,
  });

  const metafields = [
    field(SETTINGS_KEYS.defaultTo, settings.defaultTo),
    field(SETTINGS_KEYS.defaultRange, settings.defaultRange),
  ];
  if (settings.defaultFrom !== "") {
    metafields.push(field(SETTINGS_KEYS.defaultFrom, settings.defaultFrom));
  }

  const set = await run<{ metafieldsSet: { userErrors: UserError[] } }>(
    graphql,
    SET_MUTATION,
    { metafields },
  );
  const errors = set.metafieldsSet.userErrors.map((error) => error.message);

  if (settings.defaultFrom === "") {
    const removed = await run<{
      metafieldsDelete: { userErrors: UserError[] };
    }>(graphql, DELETE_MUTATION, {
      metafields: [
        { ownerId: shopId, namespace: "$app", key: SETTINGS_KEYS.defaultFrom },
      ],
    });
    errors.push(
      ...removed.metafieldsDelete.userErrors.map((error) => error.message),
    );
  }

  return errors;
}

async function run<T>(
  graphql: AdminGraphql,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await graphql(query, variables ? { variables } : undefined);
  const body = (await response.json()) as { data?: T; errors?: unknown };
  if (!body.data) {
    throw new Error(`Admin API request failed: ${JSON.stringify(body.errors)}`);
  }
  return body.data;
}
