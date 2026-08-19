import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { BillingTestHarness } from "./billing-harness";

integrationTestSuite({
    name: "CreditsService.updateCreditFloor",
    createHarness: () => BillingTestHarness.create(),
    cases: (test) => {
        test("sets a new floor for an org that already has a billing customer row", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100);

            await harness.creditsService.updateCreditFloor(orgId, -500);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditFloor).toBe(-500);
        });

        test("creates a billing customer row for an org that doesn't have one yet", async ({ harness }) => {
            const org = await harness.db.organization.create({
                data: { name: "No Billing Customer Org", slug: `no-billing-customer-${Date.now()}` },
            });

            await harness.creditsService.updateCreditFloor(org.id, -100);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({
                where: { organizationId: org.id },
            });
            expect(customer.creditFloor).toBe(-100);
            expect(customer.creditBalance).toBe(0);
        });
    },
});
