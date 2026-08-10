import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { ApplicationInstructionsConflictError } from "../../src/routes/applications/application-instructions-conflict-error";
import type { ApplicationsService } from "../../src/routes/applications/applications.service";
import { apiTestSuite } from "../api-test";

const BASELINE_INSTRUCTIONS = "Dismiss the cookie banner first.";
const BASELINE_GUIDELINES = "Do not test /admin.";

/**
 * Put both fields back to a known state. The suite shares one application across its cases, so a
 * case that assumed the seeded text would still be there would pass or fail on what ran before it.
 */
async function resetTo(applications: ApplicationsService, applicationId: string, organizationId: string) {
    await applications.updateSettings(applicationId, organizationId, {
        customInstructions: BASELINE_INSTRUCTIONS,
        testScopeGuidelines: BASELINE_GUIDELINES,
    });
}

apiTestSuite({
    name: "application instructions",
    seed: async ({ harness }) => {
        const app = await harness.services.applications.createApplication({
            name: "Instructed App",
            organizationId: harness.organizationId,
            architecture: ApplicationArchitecture.WEB,
            url: "https://example.com",
            file: "s3://bucket/default-file.png",
        });
        return { app };
    },
    cases: (test) => {
        test("leaves the other field untouched when only one is written", async ({ harness, seedResult: { app } }) => {
            const applications = harness.services.applications;
            await resetTo(applications, app.id, harness.organizationId);

            await applications.updateInstructions({
                applicationId: app.id,
                organizationId: harness.organizationId,
                testScopeGuidelines: "Do not test /admin. The 'unsaved changes' warning is intended.",
            });

            const after = await applications.getInstructions(app.id, harness.organizationId);
            expect(after.customInstructions).toBe(BASELINE_INSTRUCTIONS);
            expect(after.testScopeGuidelines).toContain("is intended");
        });

        test("accepts a write based on the fingerprint it just read", async ({ harness, seedResult: { app } }) => {
            const applications = harness.services.applications;
            await resetTo(applications, app.id, harness.organizationId);
            const before = await applications.getInstructions(app.id, harness.organizationId);

            const after = await applications.updateInstructions({
                applicationId: app.id,
                organizationId: harness.organizationId,
                customInstructions: `${BASELINE_INSTRUCTIONS} Wait for the spinner.`,
                baseFingerprint: before.fingerprint,
            });

            expect(after.customInstructions).toContain("Wait for the spinner");
            expect(after.fingerprint).not.toBe(before.fingerprint);
        });

        test("rejects a write whose base is stale, and writes nothing", async ({ harness, seedResult: { app } }) => {
            const applications = harness.services.applications;
            await resetTo(applications, app.id, harness.organizationId);
            const stale = await applications.getInstructions(app.id, harness.organizationId);

            // Someone else edits in between - the case the fingerprint exists to catch.
            await applications.updateInstructions({
                applicationId: app.id,
                organizationId: harness.organizationId,
                customInstructions: "A human rewrote this by hand.",
            });

            await expect(
                applications.updateInstructions({
                    applicationId: app.id,
                    organizationId: harness.organizationId,
                    customInstructions: "An agent's version, which never saw the human's edit.",
                    baseFingerprint: stale.fingerprint,
                }),
            ).rejects.toThrow(/changed since you read/);

            const after = await applications.getInstructions(app.id, harness.organizationId);
            expect(after.customInstructions).toBe("A human rewrote this by hand.");
        });

        test("carries the current text on the conflict, so a caller can merge and retry", async ({
            harness,
            seedResult: { app },
        }) => {
            const applications = harness.services.applications;
            await resetTo(applications, app.id, harness.organizationId);
            const stale = await applications.getInstructions(app.id, harness.organizationId);
            await applications.updateInstructions({
                applicationId: app.id,
                organizationId: harness.organizationId,
                testScopeGuidelines: "Do not test /admin. Billing is out of scope.",
            });

            const conflict = await applications
                .updateInstructions({
                    applicationId: app.id,
                    organizationId: harness.organizationId,
                    testScopeGuidelines: "Do not test /admin. Also the export banner is intended.",
                    baseFingerprint: stale.fingerprint,
                })
                .then(
                    () => undefined,
                    (err: unknown) => (err instanceof ApplicationInstructionsConflictError ? err : undefined),
                );

            if (conflict == null) throw new Error("expected a conflict carrying the current text");
            expect(conflict.conflict.current.testScopeGuidelines).toBe("Do not test /admin. Billing is out of scope.");

            // The merge the caller is expected to make, on the fingerprint the conflict handed back.
            const merged = await applications.updateInstructions({
                applicationId: app.id,
                organizationId: harness.organizationId,
                testScopeGuidelines: "Do not test /admin. Billing is out of scope. Also the export banner is intended.",
                baseFingerprint: conflict.conflict.currentFingerprint,
            });
            expect(merged.testScopeGuidelines).toContain("Billing is out of scope");
            expect(merged.testScopeGuidelines).toContain("export banner");
        });

        test("treats blank text as clearing the field", async ({ harness, seedResult: { app } }) => {
            const applications = harness.services.applications;
            await resetTo(applications, app.id, harness.organizationId);

            const after = await applications.updateInstructions({
                applicationId: app.id,
                organizationId: harness.organizationId,
                customInstructions: "   ",
            });

            expect(after.customInstructions).toBeNull();
        });

        test("trims stored text, so the fingerprint does not move on whitespace alone", async ({
            harness,
            seedResult: { app },
        }) => {
            const applications = harness.services.applications;
            await resetTo(applications, app.id, harness.organizationId);

            const first = await applications.updateInstructions({
                applicationId: app.id,
                organizationId: harness.organizationId,
                customInstructions: "Wait for the spinner.",
            });
            const second = await applications.updateInstructions({
                applicationId: app.id,
                organizationId: harness.organizationId,
                customInstructions: "  Wait for the spinner.  ",
            });

            expect(second.customInstructions).toBe("Wait for the spinner.");
            expect(second.fingerprint).toBe(first.fingerprint);
        });

        test("refuses to read or write an application another organization owns", async ({
            harness,
            seedResult: { app },
        }) => {
            const applications = harness.services.applications;
            await resetTo(applications, app.id, harness.organizationId);

            await expect(applications.getInstructions(app.id, "org-that-does-not-own-it")).rejects.toThrow();
            await expect(
                applications.updateInstructions({
                    applicationId: app.id,
                    organizationId: "org-that-does-not-own-it",
                    customInstructions: "Written from the wrong org.",
                }),
            ).rejects.toThrow();

            const after = await applications.getInstructions(app.id, harness.organizationId);
            expect(after.customInstructions).toBe(BASELINE_INSTRUCTIONS);
        });
    },
});
