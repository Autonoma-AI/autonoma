import { expect } from "vitest";
import { apiTestSuite } from "../api-test";

/**
 * `auth.activeOrg.mergeGateEnabled` is the flag the frontend gates the activation UI on (the analysis-triggers
 * settings tab + page and the PR "Run analysis" button). It must be true ONLY when the org has opted into the
 * merge gate - so a client that has not enabled it never sees the UI. The integration env sets the global
 * MERGE_GATE_ENABLED switch on, so these cases exercise the per-org opt-in dimension.
 */
apiTestSuite({
    name: "activeOrg mergeGateEnabled flag",
    seed: async () => ({}),
    cases: (test) => {
        test("is false when the org has no settings row (has not opted in)", async ({ harness }) => {
            await harness.db.organizationSettings.deleteMany({ where: { organizationId: harness.organizationId } });

            const org = await harness.services.auth.getActiveOrg(harness.organizationId, undefined);

            expect(org?.mergeGateEnabled).toBe(false);
        });

        test("is false when the org's mergeGateEnabled is off", async ({ harness }) => {
            await harness.db.organizationSettings.upsert({
                where: { organizationId: harness.organizationId },
                create: { organizationId: harness.organizationId, mergeGateEnabled: false },
                update: { mergeGateEnabled: false },
            });

            const org = await harness.services.auth.getActiveOrg(harness.organizationId, undefined);

            expect(org?.mergeGateEnabled).toBe(false);
        });

        test("is true only once the org opts into the merge gate", async ({ harness }) => {
            await harness.db.organizationSettings.upsert({
                where: { organizationId: harness.organizationId },
                create: { organizationId: harness.organizationId, mergeGateEnabled: true },
                update: { mergeGateEnabled: true },
            });

            const enabled = await harness.services.auth.getActiveOrg(harness.organizationId, undefined);
            expect(enabled?.mergeGateEnabled).toBe(true);

            // Flipping the org opt-in back off hides the UI again.
            await harness.db.organizationSettings.update({
                where: { organizationId: harness.organizationId },
                data: { mergeGateEnabled: false },
            });
            const disabled = await harness.services.auth.getActiveOrg(harness.organizationId, undefined);
            expect(disabled?.mergeGateEnabled).toBe(false);
        });
    },
});
