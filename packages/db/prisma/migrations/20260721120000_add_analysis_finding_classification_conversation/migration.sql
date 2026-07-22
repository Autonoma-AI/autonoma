-- AlterTable
-- Additive: the display-only s3:// key of the Investigator classifier's persisted conversation, threaded from
-- the classify activity onto the finding row and signed on read. No backfill - older findings have no link.
ALTER TABLE "analysis_finding" ADD COLUMN "classification_conversation_url" TEXT;
