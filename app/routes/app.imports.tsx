import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { requireAdminTenant } from "../lib/admin.server";
import { cancelImport, createImport, IMPORT_LIMITS, ImportError, listImports, runImport, skuLookupFromAdmin } from "../lib/import.server";

// Imports (minimal boundary for the import engine; the guided wizard with manual product matching is checkpoint 8).
// The shop is always the authenticated one; nothing in the form or the file can choose a tenant.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdminTenant(request);
  const jobs = await listImports(shop.id);
  return { jobs: jobs.map((j) => ({ ...j, createdAt: j.createdAt.toISOString().slice(0, 16).replace("T", " ") })) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin, actor } = await requireAdminTenant(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const graphql = admin.graphql;
  try {
    if (intent === "upload") {
      const csv = form.get("csv");
      const images = form.get("images");
      if (!(csv instanceof File) || !csv.size) return { message: "Choose a CSV file." };
      if (csv.size > IMPORT_LIMITS.csvBytes) return { message: "The CSV file is larger than 50 MB." };
      if (images instanceof File && images.size > IMPORT_LIMITS.archiveBytes) return { message: "The images archive is larger than 2 GB." };
      const { jobId, analysis } = await createImport(shop.id, {
        csv: Buffer.from(await csv.arrayBuffer()),
        images: images instanceof File && images.size ? Buffer.from(await images.arrayBuffer()) : null,
        options: { source: "csv", publishMode: form.get("publishMode") === "moderate" ? "moderate" : "publish" },
        actor, skuLookup: skuLookupFromAdmin(graphql),
      });
      // ponytail: runs in this server process; a job runner will take over (the job is resumable either way).
      void runImport(shop.id, jobId, { graphql }).catch(() => {});
      return { message: `Import started: ${analysis.validRows} of ${analysis.totalRows} rows ready, ${analysis.unmatchedRows} unmatched, ${analysis.ambiguousRows} ambiguous.` };
    }
    const jobId = String(form.get("jobId") ?? "");
    if (intent === "resume") { void runImport(shop.id, jobId, { graphql }).catch(() => {}); return { message: "Import resumed." }; }
    if (intent === "cancel") { await cancelImport(shop.id, jobId, actor); return { message: "Import cancelled. Reviews already imported are kept." }; }
  } catch (e) {
    if (e instanceof ImportError) return { message: e.message };
    throw e;
  }
  return { message: "Unknown action." };
};

export default function Imports() {
  const { jobs } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  return (
    <s-page heading="Import reviews">
      {result && <s-banner tone="info"><s-paragraph>{result.message}</s-paragraph></s-banner>}
      <s-section heading="New import">
        <Form method="post" encType="multipart/form-data">
          <s-stack gap="base">
            <input type="hidden" name="intent" value="upload" />
            <label>Reviews CSV (UTF-8, up to 50 MB) <input type="file" name="csv" accept=".csv,text/csv" required /></label>
            <label>Photos ZIP (optional, up to 2 GB; JPEG, PNG or WebP, up to 20 MB each) <input type="file" name="images" accept=".zip,application/zip" /></label>
            <label><input type="radio" name="publishMode" value="publish" defaultChecked /> Publish imported reviews (within your plan&apos;s allowance)</label>
            <label><input type="radio" name="publishMode" value="moderate" /> Hold all imported reviews for moderation</label>
            <s-button type="submit" variant="primary" loading={busy || undefined}>Start import</s-button>
          </s-stack>
        </Form>
      </s-section>
      <s-section heading="History">
        {jobs.length === 0 ? <s-paragraph>No imports yet.</s-paragraph> : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Started</s-table-header><s-table-header>Status</s-table-header><s-table-header>Rows</s-table-header><s-table-header>Result</s-table-header><s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {jobs.map((j) => {
                const c = j.counts as Record<string, number>;
                const a = j.analysis as Record<string, number>;
                return (
                  <s-table-row key={j.id}>
                    <s-table-cell>{j.createdAt} UTC</s-table-cell>
                    <s-table-cell>{j.status.replaceAll("_", " ")}{j.error ? ` — ${j.error}` : ""}</s-table-cell>
                    <s-table-cell>{j.cursor} / {j.totalRows}</s-table-cell>
                    <s-table-cell>
                      {c.imported ?? 0} imported · {c.published ?? 0} published · {c.planLimited ?? 0} plan-limited · {c.awaitingModeration ?? 0} awaiting moderation ·{" "}
                      {a.unmatchedRows ?? 0} unmatched · {a.ambiguousRows ?? 0} ambiguous · {a.invalidRows ?? 0} invalid · {c.mediaAccepted ?? 0} photos ({c.mediaStorageLimited ?? 0} storage-limited, {c.mediaRejected ?? 0} rejected)
                    </s-table-cell>
                    <s-table-cell>
                      {["failed", "queued"].includes(j.status) && <Form method="post"><input type="hidden" name="intent" value="resume" /><input type="hidden" name="jobId" value={j.id} /><s-button type="submit">Resume</s-button></Form>}
                      {["queued", "running", "failed"].includes(j.status) && <Form method="post"><input type="hidden" name="intent" value="cancel" /><input type="hidden" name="jobId" value={j.id} /><s-button type="submit" tone="critical">Cancel</s-button></Form>}
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
