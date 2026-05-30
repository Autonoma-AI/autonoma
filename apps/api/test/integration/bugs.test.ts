import { tmpdir } from "node:os";
import { PostHogAnalytics } from "@autonoma/analytics";
import { ApplicationArchitecture } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { LocalStorageProvider } from "@autonoma/storage";
import { expect } from "vitest";
import { BugsService } from "../../src/routes/bugs/bugs.service";
import { apiTestSuite } from "../api-test";

interface CapturedEvent {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
}

/**
 * Records every `capture(...)` call so we can assert the emitted analytics event
 * without talking to PostHog. Extends the real class to stay strongly typed.
 */
class RecordingAnalytics extends PostHogAnalytics {
    public captures: CapturedEvent[] = [];

    override capture(distinctId: string, event: string, properties?: Record<string, unknown>): void {
        this.captures.push({ distinctId, event, properties });
    }
}

const APP_URL = "https://app.test";

apiTestSuite({
    name: "bugs.classify",
    seed: async ({ harness }) => {
        const application = await harness.services.applications.createApplication({
            name: "My Web App",
            organizationId: harness.organizationId,
            architecture: ApplicationArchitecture.WEB,
            url: "https://example.com",
            file: "s3://bucket/default-file.png",
        });

        const bug = await harness.db.bug.create({
            data: {
                title: "Login button does nothing",
                description: "Clicking login has no effect",
                severity: "high",
                status: "open",
                applicationId: application.id,
                organizationId: harness.organizationId,
            },
        });

        return { applicationId: application.id, appSlug: application.slug, bugId: bug.id };
    },
    cases: (test) => {
        test("emits bug.classified with the verdict and bug context", async ({ harness, seedResult }) => {
            const analytics = new RecordingAnalytics();
            const service = new BugsService(harness.db, new LocalStorageProvider(tmpdir()), analytics, APP_URL);

            await service.classifyBug(seedResult.bugId, harness.organizationId, harness.userId, "false_positive");

            const events = analytics.captures.filter((c) => c.event === "bug.classified");
            expect(events).toHaveLength(1);

            const event = events[0]!;
            expect(event.distinctId).toBe(harness.userId);
            expect(event.properties).toMatchObject({
                bugId: seedResult.bugId,
                verdict: "false_positive",
                applicationId: seedResult.applicationId,
                organizationId: harness.organizationId,
                severity: "high",
                status: "open",
                bugUrl: `${APP_URL}/app/${seedResult.appSlug}/bugs/${seedResult.bugId}`,
            });
        });

        test("throws NotFoundError for a bug that does not exist", async ({ harness }) => {
            const analytics = new RecordingAnalytics();
            const service = new BugsService(harness.db, new LocalStorageProvider(tmpdir()), analytics, APP_URL);

            await expect(
                service.classifyBug("non-existent-bug-id", harness.organizationId, harness.userId, "true_positive"),
            ).rejects.toBeInstanceOf(NotFoundError);

            expect(analytics.captures).toHaveLength(0);
        });

        test("throws NotFoundError when the bug belongs to another organization", async ({ harness, seedResult }) => {
            const otherOrg = await harness.db.organization.create({
                data: { name: "Other Org", slug: `other-org-${seedResult.bugId.slice(0, 8)}` },
            });
            const analytics = new RecordingAnalytics();
            const service = new BugsService(harness.db, new LocalStorageProvider(tmpdir()), analytics, APP_URL);

            await expect(
                service.classifyBug(seedResult.bugId, otherOrg.id, harness.userId, "true_positive"),
            ).rejects.toBeInstanceOf(NotFoundError);

            expect(analytics.captures).toHaveLength(0);
        });
    },
});
