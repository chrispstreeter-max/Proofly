import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { createRequestsFromOrder } from "../lib/requests.server";

// Fulfilled order → review_requests rows (foundation for review-request emails; nothing is sent yet).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload } = await authenticate.webhook(request); // verifies Shopify HMAC
  await createRequestsFromOrder(payload as Parameters<typeof createRequestsFromOrder>[0]);
  return new Response();
};
