-- DropIndex
DROP INDEX "bug_application_id_idx";

-- CreateIndex
CREATE INDEX "bug_application_id_last_seen_at_idx" ON "bug"("application_id", "last_seen_at");

-- CreateIndex
CREATE INDEX "issue_bug_id_idx" ON "issue"("bug_id");
