/** Review statuses (shared by server and admin UI; the review data itself lives in review-store.server.ts). */
export type ReviewStatus = "published" | "pending" | "rejected" | "hidden";
export const STATUSES: readonly ReviewStatus[] = ["pending", "published", "rejected", "hidden"];
