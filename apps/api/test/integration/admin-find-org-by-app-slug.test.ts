import { randomBytes } from "node:crypto";
import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { env } from "../../src/env";
import { apiTestSuite } from "../api-test";

apiTestSuite({
    name: "admin.findOrgByAppSlug",
    seed: async ({ harness }) => {
        const orgA = harness.organizationId;

        const otherOrg = await harness.db.organization.create({
            data: { name: "Other Org", slug: `other-org-${randomBytes(4).toString("hex")}` },
        });

        // The internal org dogfoods customer apps - identified by its domain.
        // Upsert because `domain` is globally unique and other suites (signup
        // hooks) may have already created it.
        const internalOrg = await harness.db.organization.upsert({
            where: { domain: env.INTERNAL_DOMAIN },
            update: {},
            create: {
                name: "Internal Org",
                slug: `internal-org-${randomBytes(4).toString("hex")}`,
                domain: env.INTERNAL_DOMAIN,
            },
        });

        // Unique slug living in the caller's active org.
        await harness.db.application.create({
            data: {
                name: "Alpha App",
                slug: "alpha-app",
                organizationId: orgA,
                architecture: ApplicationArchitecture.WEB,
            },
        });

        // Unique slug living in a different org - the cross-org case we care about.
        await harness.db.application.create({
            data: {
                name: "Beta App",
                slug: "beta-app",
                organizationId: otherOrg.id,
                architecture: ApplicationArchitecture.WEB,
            },
        });

        // Same slug in BOTH orgs - ambiguous, cannot be resolved from the URL alone.
        await harness.db.application.create({
            data: {
                name: "Shared A",
                slug: "shared-app",
                organizationId: orgA,
                architecture: ApplicationArchitecture.WEB,
            },
        });
        await harness.db.application.create({
            data: {
                name: "Shared B",
                slug: "shared-app",
                organizationId: otherOrg.id,
                architecture: ApplicationArchitecture.WEB,
            },
        });

        // Same slug in two orgs but disabled in one - the single live match should win.
        await harness.db.application.create({
            data: {
                name: "Half Disabled A",
                slug: "half-disabled",
                organizationId: orgA,
                architecture: ApplicationArchitecture.WEB,
            },
        });
        await harness.db.application.create({
            data: {
                name: "Half Disabled B",
                slug: "half-disabled",
                organizationId: otherOrg.id,
                architecture: ApplicationArchitecture.WEB,
                disabled: true,
            },
        });

        // Slug whose only owner is disabled - treated as not found.
        await harness.db.application.create({
            data: {
                name: "Gone App",
                slug: "gone-app",
                organizationId: orgA,
                architecture: ApplicationArchitecture.WEB,
                disabled: true,
            },
        });

        // Slug shared between the internal org (a dogfood copy) and a real
        // customer org - the customer org should win. Internal org name is unique
        // per the upsert, so use a slug-scoped name unlikely to collide.
        await harness.db.application.create({
            data: {
                name: `Dogfood Internal ${randomBytes(4).toString("hex")}`,
                slug: "dogfood-app",
                organizationId: internalOrg.id,
                architecture: ApplicationArchitecture.WEB,
            },
        });
        await harness.db.application.create({
            data: {
                name: "Dogfood Customer",
                slug: "dogfood-app",
                organizationId: otherOrg.id,
                architecture: ApplicationArchitecture.WEB,
            },
        });

        // Slug that only exists in the internal org - still resolvable, since
        // there is no customer org to prefer.
        await harness.db.application.create({
            data: {
                name: `Internal Only ${randomBytes(4).toString("hex")}`,
                slug: "internal-only-app",
                organizationId: internalOrg.id,
                architecture: ApplicationArchitecture.WEB,
            },
        });

        return { orgA, otherOrgId: otherOrg.id, internalOrgId: internalOrg.id };
    },
    cases: (test) => {
        test("resolves the owning org for a unique slug in another org", async ({
            harness,
            seedResult: { otherOrgId },
        }) => {
            const result = await harness.services.admin.findOrgByAppSlug("beta-app");
            expect(result?.orgId).toBe(otherOrgId);
        });

        test("resolves the owning org for a unique slug in the active org", async ({
            harness,
            seedResult: { orgA },
        }) => {
            const result = await harness.services.admin.findOrgByAppSlug("alpha-app");
            expect(result?.orgId).toBe(orgA);
        });

        test("returns undefined for an unknown slug", async ({ harness }) => {
            expect(await harness.services.admin.findOrgByAppSlug("does-not-exist")).toBeUndefined();
        });

        test("returns undefined when the slug exists in multiple orgs", async ({ harness }) => {
            expect(await harness.services.admin.findOrgByAppSlug("shared-app")).toBeUndefined();
        });

        test("ignores disabled apps so a single live match still resolves", async ({
            harness,
            seedResult: { orgA },
        }) => {
            const result = await harness.services.admin.findOrgByAppSlug("half-disabled");
            expect(result?.orgId).toBe(orgA);
        });

        test("returns undefined when the only matching app is disabled", async ({ harness }) => {
            expect(await harness.services.admin.findOrgByAppSlug("gone-app")).toBeUndefined();
        });

        test("prefers the customer org over the internal dogfood copy", async ({
            harness,
            seedResult: { otherOrgId },
        }) => {
            const result = await harness.services.admin.findOrgByAppSlug("dogfood-app");
            expect(result?.orgId).toBe(otherOrgId);
        });

        test("still resolves a slug that only exists in the internal org", async ({
            harness,
            seedResult: { internalOrgId },
        }) => {
            const result = await harness.services.admin.findOrgByAppSlug("internal-only-app");
            expect(result?.orgId).toBe(internalOrgId);
        });
    },
});
