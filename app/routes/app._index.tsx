import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getFrankfurterClient, type Currency } from "../lib/frankfurter.server";
import { HISTORY_RANGES, RANGE_LABELS } from "../lib/ranges";
import { loadSettings, saveSettings } from "../lib/settings.server";
import { validateSettings } from "../lib/validation";

const GROUP_LABELS: Record<Currency["type"], string> = {
  currency: "Currencies",
  metal: "Precious metals",
  crypto: "Cryptocurrencies",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const stored = await loadSettings(admin.graphql);

  let currencies: Currency[] = [];
  try {
    currencies = await getFrankfurterClient().getCurrencies();
  } catch {
    // The page still renders; the banner explains why the lists are empty.
  }

  return { ...stored, currencies };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();

  let supported: Set<string>;
  try {
    supported = await getFrankfurterClient().getSupportedCodes();
  } catch {
    return {
      ok: false as const,
      message:
        "The currency list is unavailable right now. Please try again later.",
    };
  }

  const result = validateSettings(
    {
      defaultFrom: form.get("defaultFrom"),
      defaultTo: form.get("defaultTo"),
      defaultRange: form.get("defaultRange"),
    },
    supported,
  );
  if (!result.ok) return { ok: false as const, message: result.message };

  const { shopId } = await loadSettings(admin.graphql);
  const errors = await saveSettings(admin.graphql, shopId, result.value);
  if (errors.length > 0) {
    return { ok: false as const, message: errors.join(" ") };
  }

  return { ok: true as const, message: "Settings saved" };
};

function CurrencyOptions({ currencies }: { currencies: Currency[] }) {
  return (
    <>
      {(Object.keys(GROUP_LABELS) as Currency["type"][]).map((type) => {
        const items = currencies.filter((currency) => currency.type === type);
        if (items.length === 0) return null;
        return (
          <s-option-group key={type} label={GROUP_LABELS[type]}>
            {items.map((currency) => (
              <s-option key={currency.code} value={currency.code}>
                {`${currency.code} · ${currency.name}`}
              </s-option>
            ))}
          </s-option-group>
        );
      })}
    </>
  );
}

export default function Settings() {
  const { settings, currencies, shopCurrency } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const saving = navigation.state === "submitting";

  useEffect(() => {
    if (actionData?.ok) shopify.toast.show(actionData.message);
  }, [actionData, shopify]);

  return (
    <Form method="post" data-save-bar>
      <s-page heading="Currency Converter" inlineSize="small">
        <s-button
          slot="primary-action"
          variant="primary"
          type="submit"
          loading={saving}
        >
          Save
        </s-button>

        {currencies.length === 0 && (
          <s-banner tone="critical" heading="Currency list unavailable">
            The exchange rate service could not be reached, so settings cannot
            be changed right now. The storefront block keeps using the saved
            values.
          </s-banner>
        )}

        {actionData && !actionData.ok && (
          <s-banner tone="critical" heading="Settings not saved">
            {actionData.message}
          </s-banner>
        )}

        <s-section
          heading="Default currency pair"
          subheading="The pair shoppers see first. They can change it in the block."
        >
          <s-stack gap="base">
            <s-select
              label="Default From"
              name="defaultFrom"
              value={settings.defaultFrom}
              details={`Leave on the first option to use the shopper's current currency (your store currency is ${shopCurrency}).`}
            >
              <s-option value="">{"Shopper's current currency"}</s-option>
              <CurrencyOptions currencies={currencies} />
            </s-select>
            <s-select
              label="Default To"
              name="defaultTo"
              value={settings.defaultTo}
            >
              <CurrencyOptions currencies={currencies} />
            </s-select>
          </s-stack>
        </s-section>

        <s-section
          heading="Chart"
          subheading="1Y shows weekly points and 5Y shows monthly points."
        >
          <s-select
            label="Default range"
            name="defaultRange"
            value={settings.defaultRange}
          >
            {HISTORY_RANGES.map((range) => (
              <s-option key={range} value={range}>
                {RANGE_LABELS[range]}
              </s-option>
            ))}
          </s-select>
        </s-section>

        <s-section heading="Add the block to your theme">
          <s-paragraph>
            In the theme editor, open the page where the converter should
            appear, choose Add block or Add section, and pick Currency Converter
            under Apps.
          </s-paragraph>
        </s-section>
      </s-page>
    </Form>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
