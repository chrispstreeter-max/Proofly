-- AlterTable
ALTER TABLE "review_requests" ALTER COLUMN "token_hash" DROP NOT NULL,
ALTER COLUMN "expires_at" DROP NOT NULL;
