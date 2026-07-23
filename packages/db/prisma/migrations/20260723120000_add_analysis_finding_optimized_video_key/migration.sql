-- AlterTable
-- Additive: the display-only s3:// key of the dead-time-stripped mp4 recording, threaded from the classify
-- activity onto the finding row and signed on read to back the Optimized/Original toggle. No backfill - older
-- findings have no optimized recording.
ALTER TABLE "analysis_finding" ADD COLUMN "optimized_video_key" TEXT;
