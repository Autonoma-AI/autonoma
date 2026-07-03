import { db } from "@autonoma/db";
import { InvestigationReportPersister, parseReportMarkdown } from "@autonoma/investigation";
import { getStorage } from "../src/services";

// One-off: migrate legacy investigation reports (persisted only as S3 markdown, pre-island) into the queryable
// island tables (InvestigationReport + findings/suggested). Downloads each legacy report's markdown, parses it
// into the UI contract, and persists it via the same path the worker now uses - so the in-app "View
// investigation" page reads historical reports from the DB.
//
// A report is "legacy" iff its denormalized header was never written (app_slug is null); island reports are
// skipped. Best-effort per row: a single bad report never aborts the run. Usage:
//   tsx --env-file=<env> scripts/backfill-report-island.ts

/** Bounded page size - the legacy set is finite (won't grow post-deploy), but we still page rather than slurp all. */
const BATCH_SIZE = 200;

async function main(): Promise<void> {
    const storage = getStorage();
    const persister = new InvestigationReportPersister(db);

    let written = 0;
    const failed = new Set<string>();
    for (;;) {
        // Legacy reports only: the island persister always stamps app_slug, so its absence marks a pre-island row.
        // A successful backfill stamps app_slug, draining the row from this filter; failures are excluded by id so
        // the loop terminates instead of re-fetching a permanently-bad row forever.
        const batch = await db.investigationReport.findMany({
            where: {
                appSlug: null,
                s3Key: { not: null },
                ...(failed.size > 0 ? { snapshotId: { notIn: [...failed] } } : {}),
            },
            select: { snapshotId: true, s3Key: true, organizationId: true },
            take: BATCH_SIZE,
        });
        if (batch.length === 0) break;

        for (const report of batch) {
            if (report.s3Key == null) continue;
            try {
                const markdown = (await storage.download(report.s3Key)).toString("utf8");
                const data = parseReportMarkdown(markdown);
                await persister.persist({
                    snapshotId: report.snapshotId,
                    organizationId: report.organizationId,
                    data,
                    s3Key: report.s3Key,
                });
                written += 1;
            } catch (error) {
                failed.add(report.snapshotId);
                console.warn(
                    `  failed ${report.snapshotId}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
        console.log(`  progress: written=${written}, failed=${failed.size}`);
    }
    console.log(`done: written=${written}, failed=${failed.size}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
