-- A quarantine is fully described by its Issue: the Issue's `kind` is the
-- quarantine reason, the Issue's `bug_id` is the linked Bug. Collapse to a
-- single FK on test_case_assignment instead of duplicating reason/bug_id.

DROP TABLE "test_case_quarantine";

DROP TYPE "quarantine_reason";

ALTER TABLE "test_case_assignment"
    ADD COLUMN "quarantine_issue_id" TEXT;

ALTER TABLE "test_case_assignment"
    ADD CONSTRAINT "test_case_assignment_quarantine_issue_id_fkey"
        FOREIGN KEY ("quarantine_issue_id")
        REFERENCES "issue"("id") ON DELETE SET NULL ON UPDATE CASCADE;
