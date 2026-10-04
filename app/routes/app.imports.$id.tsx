import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useEffect } from "react";
import { Form, redirect, useActionData, useLoaderData, useNavigation, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { requireAdminTenant } from "../lib/admin.server";
import {
  cancelImport, explain, getImport, ImportError, refreshAnalysis, reimportFromJob, resolveProductMatch, runImport, skuLookupFromAdmin,
} from "../lib/import.server";
import { IMPORT_FILE_RETENTION_DAYS } from "../lib/maintenance.server";
import { isUuid, withTenant } from "../lib/tenant.server";

// One import: what the file contains, which products need the merchant's decision, and the outcome. Another shop's
// import id is the same 404 as a missing one. Product choices are always validated server-side as this shop's products.
const notFound = () => new Response("Not found", { status: 404 });

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await requireAdminTenant(request);
  if (!isUuid(params.id)) throw notFound();
  const job = await getImport(shop.id, params.id);
  if (!job) throw notFound();
  const pq = new URL(request.url).searchParams.get("pq")?.trim().slice(0, 100) ?? "";
  const search = pq
    ? await withTenant(shop.id, ({ db, shopId }) => db.product.findMany({
        where: { shopId, deletedAt: null, OR: [{ title: { contains: pq, mode: "insensitive" } }, { handle: { contains: pq, mode: "insensitive" } }] },
        orderBy: { title: "asc" }, take: 20, select: { id: true, title: true, handle: true },
      }))
    : [];
  const a = job.analysis as { problems?: { record: number; code: string | null; warnings: string[] }[] } & Record<string, unknown>;
  return {
    job: { ...job, createdAt: job.createdAt.toISOString().slice(0, 16).replace("T", " "), finishedAt: job.finishedAt?.toISOString().slice(0, 16).replace("T", " ") ?? null },
    problems: (a.problems ?? []).slice(0, 50).map((p) => ({ record: p.record, text: [p.code, ...p.warnings].filter(Boolean).map((c) => explain(c as string)).join(" ") })),
    attention: job.matches.filter((m) => m.status !== "matched" || m.method === "manual").map((m) => ({ ...m, refKey: JSON.stringify(m.ref), explanation: m.reason ? explain(m.reason) : "" })),
    pq, search, retentionDays: IMPORT_FILE_RETENTION_DAYS,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shop, admin, api, actor } = await requireAdminTenant(request);
  if (!isUuid(params.id)) throw notFound();
  const jobId = params.id;
  const form = await request.formData();
  const intent = form.get("intent");
  try {
    if (intent === "match" || intent === "skip") {
      const ref = String(form.get("ref") ?? "");
      const product = intent === "skip" ? null : String(form.get("productId") ?? "");
      await resolveProductMatch(shop.id, jobId, ref, product, actor);
      const job = await getImport(shop.id, jobId);
      if (job?.status === "queued") await refreshAnalysis(shop.id, jobId);
      return { message: intent === "skip" ? "Those reviews will be skipped." : "Product matched." };
    }
    if (intent === "start" || intent === "resume") {
      // ponytail: runs in this server process; the maintenance worker resumes stalled imports (the job is resumable).
      void runImport(api, jobId).catch(() => {});
      return { message: "Import started.", started: true };
    }
    if (intent === "cancel") { await cancelImport(shop.id, jobId, actor); return { message: "Import cancelled. Reviews already imported are kept." }; }
    if (intent === "reimport") {
      const { jobId: next } = await reimportFromJob(shop.id, jobId, actor, skuLookupFromAdmin(admin.graphql));
      throw redirect(`/app/imports/${next}`);
    }
  } catch (e) {
    if (e instanceof ImportError) return { message: e.code === "not_found" ? "Import not found." : e.message };
    throw e;
  }
  return { message: "Unknown action." };
};

export default function ImportDetail() {
  const { job, problems, attention, pq, search, retentionDays } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const { revalidate } = useRevalidator();
  const live = job.status === "running" && !job.stalled;
  const poll = live || (job.status === "queued" && !!result && "started" in result); // until the worker picks it up
  useEffect(() => {
    if (!poll) return;
    const t = setInterval(revalidate, 3000); // progress updates while the import runs
    return () => clearInterval(t);
  }, [poll, revalidate]);
  const a = job.analysis as Record<string, number>;
  const c = job.counts as Record<string, number>;
  const unresolved = attention.filter((m) => m.status !== "matched" && m.reason !== "skipped_by_merchant").length;
  const download = async () => {
    const res = await fetch(`/app/imports/${job.id}/report`); // App Bridge adds the session token
    const url = URL.createObjectURL(await res.blob());
    Object.assign(document.createElement("a"), { href: url, download: `proofly-import-${job.id.slice(0, 8)}-problems.csv` }).click();
    URL.revokeObjectURL(url);
  };
  return (
    <s-page heading={`Import · ${job.status.replaceAll("_", " ")}`}>
      {result && <s-banner tone="info"><s-paragraph>{result.message}</s-paragraph></s-banner>}
      {job.filesDeletedAt && <s-banner tone="info"><s-paragraph>The uploaded file was deleted {retentionDays} days after this import finished (Proofly keeps import files only as long as needed). Imported reviews are not affected; to import more rows, upload the file again — rows already imported are skipped.</s-paragraph></s-banner>}
      {job.error && <s-banner tone="critical"><s-paragraph>{job.error} Your data is safe; you can resume.</s-paragraph></s-banner>}
      <s-section heading="File">
        <s-paragraph>
          {live && <>Importing… {job.processedRows} of {job.totalRows} rows processed. </>}
          {a.totalRows} rows · {a.validRows} ready to import · {a.invalidRows} with errors · {a.duplicateSourceRows} duplicates ·
          {" "}{a.unmatchedRows} unmatched product · {a.ambiguousRows} ambiguous product. Started {job.createdAt} UTC.
        </s-paragraph>
        <s-stack direction="inline" gap="base">
          {job.status === "queued" && <Form method="post"><input type="hidden" name="intent" value="start" /><s-button type="submit" variant="primary" loading={busy || undefined}>{unresolved ? `Start import (${unresolved} product${unresolved === 1 ? "" : "s"} unresolved — those rows are skipped)` : "Start import"}</s-button></Form>}
          {(job.status === "failed" || job.stalled) && <Form method="post"><input type="hidden" name="intent" value="resume" /><s-button type="submit" variant="primary">Resume import</s-button></Form>}
          {["queued", "running", "failed"].includes(job.status) && <Form method="post"><input type="hidden" name="intent" value="cancel" /><s-button type="submit" tone="critical">Cancel</s-button></Form>}
          {!job.filesDeletedAt && ["completed", "completed_with_warnings", "cancelled"].includes(job.status) && attention.some((m) => m.method === "manual") && (
            <Form method="post"><input type="hidden" name="intent" value="reimport" /><s-button type="submit" variant="primary">Import newly matched rows</s-button></Form>
          )}
          {!job.filesDeletedAt && <s-button onClick={download}>Download problem report (CSV)</s-button>}
        </s-stack>
      </s-section>

      {c.imported !== undefined && (
        <s-section heading="Result">
          <s-paragraph>
            {c.imported} imported · {c.published ?? 0} published · {c.planLimited ?? 0} held by your plan limit · {c.awaitingModeration ?? 0} awaiting moderation ·
            {" "}{c.alreadyImported ?? 0} already imported earlier ·
            {" "}{c.repliesImported ?? 0} replies ({c.repliesSuppressed ?? 0} hidden until your plan includes replies). Nothing is deleted because of a plan limit.
          </s-paragraph>
        </s-section>
      )}

      {attention.length > 0 && (
        <s-section heading="Products that need your decision">
          <s-stack gap="base">
            <s-paragraph>Proofly never guesses a product. Titles are never matched automatically; suggestions below are only suggestions.</s-paragraph>
            <Form method="get"><s-stack direction="inline" gap="base"><s-text-field name="pq" label="Find one of your products" value={pq} /><s-button type="submit">Search</s-button></s-stack></Form>
            {attention.map((m) => (
              <s-box key={m.refKey} padding="base" border="base" borderRadius="base">
                <s-stack gap="small">
                  <s-text>
                    {[m.ref.id && `id ${m.ref.id}`, m.ref.handle && `handle “${m.ref.handle}”`, m.ref.sku && `SKU ${m.ref.sku}`, m.ref.title && `title “${m.ref.title}”`].filter(Boolean).join(" · ")} — {m.rows} row{m.rows === 1 ? "" : "s"}
                  </s-text>
                  <s-text color="subdued">{m.method === "manual" ? "Matched by you." : m.explanation}</s-text>
                  {m.status !== "matched" && (
                    <Form method="post">
                      <s-stack direction="inline" gap="base">
                        <input type="hidden" name="intent" value="match" /><input type="hidden" name="ref" value={m.refKey} />
                        <select name="productId" required defaultValue="" aria-label="Product">
                          <option value="" disabled>Choose a product…</option>
                          {(m.candidates as { productId: string; title: string; handle: string; via: string }[]).map((cand) => <option key={cand.productId} value={cand.productId}>{cand.title} ({cand.handle}) — suggested by {cand.via}</option>)}
                          {search.map((p) => <option key={p.id} value={p.id}>{p.title} ({p.handle})</option>)}
                        </select>
                        <s-button type="submit">Confirm match</s-button>
                      </s-stack>
                    </Form>
                  )}
                  {m.status !== "matched" && m.reason !== "skipped_by_merchant" && (
                    <Form method="post"><input type="hidden" name="intent" value="skip" /><input type="hidden" name="ref" value={m.refKey} /><s-button type="submit" variant="tertiary">Skip these reviews</s-button></Form>
                  )}
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-section>
      )}

      {problems.length > 0 && (
        <s-section heading="Rows with problems (first 50 — download the report for all)">
          <s-unordered-list>{problems.map((p) => <s-list-item key={p.record}>Row {p.record}: {p.text}</s-list-item>)}</s-unordered-list>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
