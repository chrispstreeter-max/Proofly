import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

// Public landing page. Proofly is installed from the Shopify App Store (Shopify-managed installation) and opened
// from the Shopify admin — there is deliberately no "enter your shop domain" login. When Shopify opens the app URL
// with ?shop=&host=, hand over to /app, where the shop is taken from the verified session token, not these params.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) throw redirect(`/app?${url.searchParams.toString()}`);
  return null;
};

export default function Landing() {
  return (
    <main style={{ display: "grid", placeItems: "center", minHeight: "100vh", padding: "1rem", textAlign: "center", fontFamily: "system-ui, sans-serif" }}>
      <div>
        <h1>Proofly</h1>
        <p style={{ fontSize: "1.2rem" }}>Product reviews for Shopify. Bring your existing reviews with you.</p>
        <p>Install Proofly from the Shopify App Store, then open it from your Shopify admin.</p>
      </div>
    </main>
  );
}
