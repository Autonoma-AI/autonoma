-- CreateTable
CREATE TABLE "investigation_report" (
    "snapshot_id" TEXT NOT NULL,
    "s3_key" TEXT NOT NULL,
    "test_count" INTEGER NOT NULL DEFAULT 0,
    "client_bug_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" TEXT NOT NULL,

    CONSTRAINT "investigation_report_pkey" PRIMARY KEY ("snapshot_id")
);

-- AddForeignKey
ALTER TABLE "investigation_report" ADD CONSTRAINT "investigation_report_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "branch_snapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investigation_report" ADD CONSTRAINT "investigation_report_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
