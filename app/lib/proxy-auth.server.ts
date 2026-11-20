import { authenticate } from "../shopify.server";

/**
 * Verify the app proxy HMAC signature. The library throws a 400 Response when
 * the signature is missing or wrong; the proxy handlers turn any rejection
 * into a JSON 401.
 */
export async function verifyAppProxy(request: Request): Promise<void> {
  await authenticate.public.appProxy(request);
}
