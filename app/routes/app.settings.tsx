import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { requireAdminTenant } from "../lib/admin.server";
import { setProxyPath } from "../lib/proxy-path.server";
import { updateSettings } from "../lib/settings.server";
import { publishShopProxyPath, publishStorefrontSettings, withTenant } from "../lib/tenant.server";

// Store settings. Enforced on the server for every storefront request; mirrored to the theme only for display.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdminTenant(request);
  const s = await withTenant(shop.id, ({ db, shopId }) => db.shopSettings.findUniqueOrThrow({ where: { shopId } }));
  return {
    moderationEnabled: s.moderationEnabled, reviewSubmissionEnabled: s.reviewSubmissionEnabled,
    proxyPath: s.proxyPath, proxyPublished: s.proxyPathPublished === s.proxyPath,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin, actor } = await requireAdminTenant(request);
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "settings") {
    const on = (k: string) => form.get(k) === "on";
    await withTenant(shop.id, (t) => updateSettings(t, { moderationEnabled: on("moderationEnabled"), reviewSubmissionEnabled: on("reviewSubmissionEnabled") }, actor));
    const ok = await publishStorefrontSettings(shop.id, admin.graphql).then(() => true, () => false);
    return { message: ok ? "Settings saved." : "Settings saved and enforced. Updating your theme's display will be retried." };
  }
  if (intent === "proxy_path") {
    const path = await withTenant(shop.id, (t) => setProxyPath(t, form.get("proxy_path"), actor));
    if (!path) return { message: "Enter the proxy path exactly as set in Shopify, for example /apps/reviews." };
    const ok = await publishShopProxyPath(shop.id, admin.graphql).then(() => true, () => false);
    return { message: ok ? `Storefront proxy path set to ${path}.` : `Saved ${path}; publishing it to your theme will be retried.` };
  }
  return { message: "Unknown action." };
};

export default function Settings() {
  const d = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const box = (name: string, label: string, checked: boolean, details: string) => (
    <s-checkbox name={name} label={label} details={details} defaultChecked={checked || undefined} />
  );
  return (
    <s-page heading="Settings">
      {result && <s-banner tone="info"><s-paragraph>{result.message}</s-paragraph></s-banner>}
      <s-section heading="Reviews from your store">
        <Form method="post">
          <s-stack gap="base">
            <input type="hidden" name="intent" value="settings" />
            {box("reviewSubmissionEnabled", "Accept new reviews from customers", d.reviewSubmissionEnabled, "When off, the “Write a review” button is hidden and new submissions are refused.")}
            {box("moderationEnabled", "Approve new reviews before they appear", d.moderationEnabled, "When off, new reviews publish immediately (within your plan's allowance).")}
            <s-button type="submit" variant="primary" loading={busy || undefined}>Save</s-button>
          </s-stack>
        </Form>
      </s-section>
      <s-section heading="Storefront connection">
        <Form method="post">
          <s-stack gap="base">
            <input type="hidden" name="intent" value="proxy_path" />
            <s-text-field name="proxy_path" label="App proxy path" value={d.proxyPath} details="Only change this if you changed Proofly's app proxy URL in Shopify (Settings → Apps). It must match exactly." />
            {!d.proxyPublished && <s-paragraph>Not yet published to your theme.</s-paragraph>}
            <s-button type="submit" loading={busy || undefined}>Save proxy path</s-button>
          </s-stack>
        </Form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
