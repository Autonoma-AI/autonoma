import { expect } from "vitest";
import { analysisSuite } from "./harness";

/** When a seeded issue was resolved; its presence IS the resolved status the ledger reads. */
const RESOLVED_AT = new Date("2026-07-01T00:00:00Z");

analysisSuite({
    name: "BranchLedger",
    cases: (test) => {
        test("openBugCount counts only unresolved bug-kind issues, by the kind enum's exact string", async ({
            harness,
        }) => {
            const run = await harness.seedAnalysis();
            const base = {
                branchId: run.branchId,
                organizationId: run.organizationId,
                actualBehavior: "misbehaves",
                narrativeMarkdown: "narrative",
            };
            for (const issue of [
                { title: "Open bug", kind: "bug", severity: "high", resolvedAt: null },
                { title: "Resolved bug", kind: "bug", severity: "high", resolvedAt: RESOLVED_AT },
                { title: "Open env", kind: "environment", severity: "high", resolvedAt: null },
                { title: "Corrupt kind", kind: "BUG!", severity: "high", resolvedAt: null },
            ]) {
                await harness.seedIssue({ ...base, ...issue });
            }

            expect(await harness.store.forBranch(run.branchId).openBugCount()).toBe(1);
        });

        test("a malformed severity degrades to low instead of hiding the issue from its resolver", async ({
            harness,
        }) => {
            const run = await harness.seedAnalysis();
            await harness.seedIssue({
                branchId: run.branchId,
                organizationId: run.organizationId,
                title: "Bug with corrupt severity",
                kind: "bug",
                severity: "URGENT",
                actualBehavior: "misbehaves",
                narrativeMarkdown: "narrative",
            });

            const ledger = harness.store.forBranch(run.branchId);
            const issues = await ledger.openIssues({ kind: "bug" });
            // The row counts toward the verdict, so the Reporter must see it - otherwise it can never resolve.
            expect(await ledger.openBugCount()).toBe(1);
            expect(issues).toHaveLength(1);
            expect(issues[0]?.severity).toBe("low");
        });

        test("coveredTestsForOpenIssues derives the covered set from attributed findings across snapshots", async ({
            harness,
        }) => {
            const run = await harness.seedAnalysis();
            const issue = await harness.seedIssue({
                branchId: run.branchId,
                organizationId: run.organizationId,
                title: "Cross-snapshot bug",
                kind: "bug",
                severity: "high",
                actualBehavior: "misbehaves",
                narrativeMarkdown: "narrative",
            });
            const first = await harness.recordVerdict(run, "checkout", "client_bug");
            const laterSnapshotId = await harness.addSnapshot(run.branchId, run.organizationId);
            const second = await harness.recordVerdict(run, "checkout", "client_bug", {
                snapshotId: laterSnapshotId,
            });
            const other = await harness.recordVerdict(run, "search", "client_bug", { snapshotId: laterSnapshotId });
            await harness.db.analysisFinding.updateMany({
                where: { id: { in: [first.findingId, second.findingId, other.findingId] } },
                data: { issueId: issue.id },
            });

            const covered = await harness.store.forBranch(run.branchId).coveredTestsForOpenIssues();
            expect(covered).toHaveLength(1);
            const slugs = covered[0]?.coveredTests.map((test) => test.slug).sort();
            // `checkout` was attributed on two snapshots but covers once.
            expect(slugs).toEqual(["checkout", "search"]);
        });

        test("priorReports excludes the analysis's own report and empty proses", async ({ harness }) => {
            const run = await harness.seedAnalysis();
            const priorId = await harness.addSnapshot(run.branchId, run.organizationId);
            const emptyId = await harness.addSnapshot(run.branchId, run.organizationId);
            await harness.db.analysisReport.createMany({
                data: [
                    {
                        snapshotId: run.snapshotId,
                        organizationId: run.organizationId,
                        title: "The run",
                        headline: "own",
                        flows: [],
                        reportMarkdown: "## Own",
                    },
                    {
                        snapshotId: priorId,
                        organizationId: run.organizationId,
                        title: "The run",
                        headline: "prior",
                        flows: [],
                        reportMarkdown: "## Prior",
                    },
                    {
                        snapshotId: emptyId,
                        organizationId: run.organizationId,
                        title: "The run",
                        headline: "",
                        flows: [],
                        reportMarkdown: "",
                    },
                ],
            });

            const prior = await harness.store
                .forBranch(run.branchId)
                .priorReports({ excludeSnapshotId: run.snapshotId, limit: 3 });
            expect(prior).toEqual([{ snapshotId: priorId, reportMarkdown: "## Prior" }]);
        });

        test("removedInvalidTests returns only tests whose current verdict is invalid_test, by slug and name", async ({
            harness,
        }) => {
            const run = await harness.seedAnalysis();
            await harness.recordVerdict(run, "gone-feature", "invalid_test");
            await harness.recordVerdict(run, "checkout", "client_bug");
            await harness.recordVerdict(run, "search", "passed");

            const removed = await harness.store.forBranch(run.branchId).removedInvalidTests();

            expect(removed.map((t) => t.slug)).toEqual(["gone-feature"]);
            expect(removed[0]?.name).toBe("gone-feature");
            // No note was recorded, so the reason falls back to the classification headline.
            expect(removed[0]?.reason).toBe("gone-feature invalid_test");
        });
    },
});
