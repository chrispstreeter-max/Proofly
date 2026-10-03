-- V1 privacy principle (locked 2026-10-04): Proofly stores no reviewer email. The column is removed, not left unused.
ALTER TABLE "reviews" DROP COLUMN "reviewer_email";
