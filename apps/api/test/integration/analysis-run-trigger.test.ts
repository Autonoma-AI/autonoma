import { randomBytes } from "node:crypto";
import { buildSdkUrl } from "@autonoma/test-updates";
import { expect } from "vitest";
import type { DiffsTriggerService, TriggerDiffsResult } from "../../src/diffs/diffs-trigger.service";
import { PreviewAnalysisRunTrigger } from "../../src/github/analysis-run-trigger";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

type TriggerPrDiffsCall = Parameters<DiffsTriggerService["triggerPrDiffs"]>[0];

/** Records what the trigger passes to `triggerPrDiffs`, so tests assert the resolved `url` + derived SDK `webhookUrl`. */
class RecordingDiffsTrigger {
    public calls: TriggerPrDiffsCall[] = [];
    async triggerPrDiffs(params: TriggerPrDiffsCall): Promise<TriggerDiffsResult> {
        this.calls.push(params);
        return { branchId: "branch-1", snapshotId: "snapshot-1" };
    }
}

interface EnvFixture {
    repoFullName: string;
    repoId: number;
    prNumber: number;
}

interface PreviewConfigInput {
    urls: Record<string, string>;
    apps: Array<{ name: string; primary?: boolean; sdk_implemented?: boolean }>;
}

apiTestSuite({
    name: "PreviewAnalysisRunTrigger.requestRun",
    cases: (test) => {
        test("derives the SDK url from the primary app for a single-app preview", async ({ harness }) => {
            const fixture = await seedPreviewEnv(harness, {
                urls: { web: "https://web-abc.preview.autonoma.app" },
                apps: [{ name: "web", primary: true }],
            });
            const diffs = new RecordingDiffsTrigger();
            const trigger = new PreviewAnalysisRunTrigger(harness.db, diffs);

            const outcome = await trigger.requestRun({
                organizationId: harness.organizationId,
                repoFullName: fixture.repoFullName,
                githubRepositoryId: fixture.repoId,
                prNumber: fixture.prNumber,
            });

            // The run is seeded/tested against the primary app, and the scenario endpoint is derived from it too.
            expect(outcome.started).toBe(true);
            expect(diffs.calls).toHaveLength(1);
            expect(diffs.calls[0]?.url).toBe("https://web-abc.preview.autonoma.app");
            expect(diffs.calls[0]?.webhookUrl).toBe(buildSdkUrl("https://web-abc.preview.autonoma.app"));
            expect(diffs.calls[0]?.requested).toBe(true);
        });

        test("derives the SDK url from the sdk_implemented app in a split front/API topology", async ({ harness }) => {
            const fixture = await seedPreviewEnv(harness, {
                urls: {
                    web: "https://web-xyz.preview.autonoma.app",
                    api: "https://api-xyz.preview.autonoma.app",
                },
                apps: [
                    { name: "web", primary: true },
                    { name: "api", sdk_implemented: true },
                ],
            });
            const diffs = new RecordingDiffsTrigger();
            const trigger = new PreviewAnalysisRunTrigger(harness.db, diffs);

            await trigger.requestRun({
                organizationId: harness.organizationId,
                repoFullName: fixture.repoFullName,
                githubRepositoryId: fixture.repoId,
                prNumber: fixture.prNumber,
            });

            // The primary app is still what the run browses, but scenario up/down must target the SDK-hosting app.
            expect(diffs.calls[0]?.url).toBe("https://web-xyz.preview.autonoma.app");
            expect(diffs.calls[0]?.webhookUrl).toBe(buildSdkUrl("https://api-xyz.preview.autonoma.app"));
        });

        test("reports no_preview and fires nothing when the PR has no live environment", async ({ harness }) => {
            const diffs = new RecordingDiffsTrigger();
            const trigger = new PreviewAnalysisRunTrigger(harness.db, diffs);

            const outcome = await trigger.requestRun({
                organizationId: harness.organizationId,
                repoFullName: `org/no-preview-${randomBytes(3).readUIntBE(0, 3)}`,
                githubRepositoryId: 424242,
                prNumber: 7,
            });

            expect(outcome).toEqual({ started: false, reason: "no_preview" });
            expect(diffs.calls).toHaveLength(0);
        });
    },
});

/** Create a live preview environment (its `urls` + `resolvedConfig.apps`) the trigger resolves URLs from. */
async function seedPreviewEnv(harness: APITestHarness, config: PreviewConfigInput): Promise<EnvFixture> {
    const repoId = 700_000 + randomBytes(3).readUIntBE(0, 3);
    const repoFullName = `org/preview-trigger-${repoId}`;
    const prNumber = 11;
    await harness.db.previewkitEnvironment.create({
        data: {
            namespace: `preview-trigger-${randomBytes(4).toString("hex")}`,
            repoFullName,
            prNumber,
            headSha: "head-1",
            headRef: "feature/x",
            githubRepositoryId: repoId,
            organizationId: harness.organizationId,
            urls: config.urls,
            resolvedConfig: { apps: config.apps },
        },
    });
    return { repoFullName, repoId, prNumber };
}
