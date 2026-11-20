import type { LoaderFunctionArgs } from "react-router";
import { getFrankfurterClient } from "../lib/frankfurter.server";
import { verifyAppProxy } from "../lib/proxy-auth.server";
import { handleCurrencies } from "../lib/proxy.server";

export const loader = ({ request }: LoaderFunctionArgs) =>
  handleCurrencies(request, {
    verify: verifyAppProxy,
    client: getFrankfurterClient(),
  });
