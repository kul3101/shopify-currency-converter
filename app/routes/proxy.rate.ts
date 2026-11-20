import type { LoaderFunctionArgs } from "react-router";
import { getFrankfurterClient } from "../lib/frankfurter.server";
import { verifyAppProxy } from "../lib/proxy-auth.server";
import { handleRate } from "../lib/proxy.server";

export const loader = ({ request }: LoaderFunctionArgs) =>
  handleRate(request, {
    verify: verifyAppProxy,
    client: getFrankfurterClient(),
  });
