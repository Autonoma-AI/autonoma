-- `plan`, `video_key` and `optimized_video_key` on analysis_classification were copies of facts the row already
-- reaches through its generation FK (the generation's immutable test_plan prompt and its recording keys). The
-- reader/writer change one deploy earlier stopped writing them and now resolves all three through that join, so
-- they have no remaining reader or writer - drop them.

-- AlterTable
ALTER TABLE "analysis_classification" DROP COLUMN "optimized_video_key",
DROP COLUMN "plan",
DROP COLUMN "video_key";
