import type { ShopApi } from "./review-store.server";

/**
 * Shopify bulk mutations (shopify.dev "Bulk import data"): one mutation run by Shopify over a JSONL file of variables
 * staged in Shopify's storage. Used for large imports and large plan releases (docs/SHOPIFY-DATA.md, Phase 3).
 *  - Input file ≤ 100 MB; any single-connection Admin mutation; up to 5 running bulk mutations per app and shop.
 *  - Results are NOT in input order: each result line carries `__lineNumber`.
 *  - A result file stays downloadable for days, so an operation can be resumed by id after a crash.
 */
export const BULK_MAX_BYTES = 90 * 1024 * 1024; // margin below Shopify's 100 MB

export const BULK_STAGED_INPUT = { resource: "BULK_MUTATION_VARIABLES", filename: "proofly_bulk.jsonl", mimeType: "text/jsonl", httpMethod: "POST" } as const;

export const STAGE_BULK_INPUT_MUTATION = `#graphql
  mutation ProoflyStageBulkInput($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } }
  }`;
export const RUN_BULK_MUTATION = `#graphql
  mutation ProoflyRunBulk($mutation: String!, $path: String!) {
    bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $path) { bulkOperation { id status } userErrors { field message code } }
  }`;
export const BULK_STATUS_QUERY = `#graphql
  query ProoflyBulkStatus($id: ID!) { bulkOperation(id: $id) { id status errorCode objectCount url partialDataUrl } }`;

export class BulkError extends Error {}

async function call<T>(api: ShopApi, query: string, variables: Record<string, unknown>): Promise<T> {
  const body = (await (await api.graphql(query, { variables })).json()) as { data?: T; errors?: unknown };
  if (body.errors || !body.data) throw new BulkError(`Shopify bulk request failed: ${JSON.stringify(body.errors ?? "no data").slice(0, 200)}`);
  return body.data;
}

/** Stages the JSONL input and starts the bulk mutation. Returns the bulk operation id (persist it to resume). */
export async function startBulk(api: ShopApi, mutation: string, lines: object[]) {
  const jsonl = lines.map((l) => JSON.stringify(l)).join("\n");
  if (Buffer.byteLength(jsonl) > BULK_MAX_BYTES) throw new BulkError("bulk input too large");
  const staged = await call<{ stagedUploadsCreate: { stagedTargets: { url: string; parameters: { name: string; value: string }[] }[]; userErrors: { message: string }[] } }>(
    api, STAGE_BULK_INPUT_MUTATION, { input: [BULK_STAGED_INPUT] },
  );
  const target = staged.stagedUploadsCreate.stagedTargets[0];
  if (!target || staged.stagedUploadsCreate.userErrors.length) throw new BulkError(`staged upload: ${JSON.stringify(staged.stagedUploadsCreate.userErrors).slice(0, 200)}`);
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value); // every parameter first, the file last
  form.append("file", new Blob([jsonl], { type: "text/jsonl" }), "proofly_bulk.jsonl");
  const up = await fetch(target.url, { method: "POST", body: form });
  if (!up.ok) throw new BulkError(`staged upload failed: HTTP ${up.status}`);
  const path = target.parameters.find((p) => p.name === "key")?.value;
  if (!path) throw new BulkError("staged upload: no key");
  const run = await call<{ bulkOperationRunMutation: { bulkOperation: { id: string } | null; userErrors: { message: string }[] } }>(api, RUN_BULK_MUTATION, { mutation, path });
  if (!run.bulkOperationRunMutation.bulkOperation) throw new BulkError(`bulk mutation: ${JSON.stringify(run.bulkOperationRunMutation.userErrors).slice(0, 200)}`);
  return run.bulkOperationRunMutation.bulkOperation.id;
}

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELED", "EXPIRED"]);
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Waits for a bulk operation and returns each input line's `data` by line number (missing = no result, e.g. the
 * operation failed before reaching it). `onPoll` runs between polls (heartbeats).
 */
export async function awaitBulk(api: ShopApi, id: string, opts: { sleep?: (ms: number) => Promise<void>; onPoll?: () => Promise<void> } = {}) {
  const sleep = opts.sleep ?? realSleep;
  for (let i = 0; ; i++) {
    const { bulkOperation: op } = await call<{ bulkOperation: { status: string; errorCode: string | null; url: string | null; partialDataUrl: string | null } | null }>(api, BULK_STATUS_QUERY, { id });
    if (!op) throw new BulkError("bulk operation not found");
    if (TERMINAL.has(op.status)) {
      const url = op.url ?? op.partialDataUrl;
      const results = new Map<number, Record<string, unknown>>();
      if (url) {
        const res = await fetch(url);
        if (!res.ok) throw new BulkError(`bulk result download failed: HTTP ${res.status}`);
        for (const line of (await res.text()).split("\n")) {
          if (!line.trim()) continue;
          const parsed = JSON.parse(line) as { data?: Record<string, unknown>; __lineNumber: number };
          if (parsed.data) results.set(parsed.__lineNumber, parsed.data);
        }
      }
      return { status: op.status, errorCode: op.errorCode, results };
    }
    await opts.onPoll?.();
    await sleep(Math.min(10_000, 1_000 * 2 ** i));
  }
}
