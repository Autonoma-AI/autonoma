import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { BillingTestHarness } from "./billing-harness";

integrationTestSuite({
    name: "CreditsService.checkPreviewDeployCreditsGate",
    createHarness: () => BillingTestHarness.create(),
    cases: (test) => {
        test("allows an org with a positive balance", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(1);

            expect(await harness.creditsService.checkPreviewDeployCreditsGate(orgId)).toEqual({ allowed: true });
        });

        test("blocks an org with a zero balance", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);

            expect(await harness.creditsService.checkPreviewDeployCreditsGate(orgId)).toEqual({
                allowed: false,
                reason: "out_of_credits",
            });
        });

        test("blocks an org with a negative balance", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            await harness.db.billingCustomer.update({ where: { organizationId: orgId }, data: { creditBalance: -5 } });

            expect(await harness.creditsService.checkPreviewDeployCreditsGate(orgId)).toEqual({
                allowed: false,
                reason: "out_of_credits",
            });
        });

        test("blocks an org with no billing customer row at all", async ({ harness }) => {
            const org = await harness.db.organization.create({
                data: { name: "No Billing Customer Org", slug: `no-billing-customer-${Date.now()}` },
            });

            expect(await harness.creditsService.checkPreviewDeployCreditsGate(org.id)).toEqual({
                allowed: false,
                reason: "out_of_credits",
            });
        });
    },
});
