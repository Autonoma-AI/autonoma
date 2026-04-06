import { File } from "node:buffer";
import { randomUUID } from "node:crypto";
import { ApplicationArchitecture } from "@autonoma/db";
import { TRPCError } from "@trpc/server";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";

apiTestSuite({
    name: "skills",
    seed: async () => ({}),
    cases: (test) => {
        test("creates, lists, and fetches a skill by slug", async ({ harness }) => {
            const suffix = randomUUID();
            const application = await harness.services.applications.createApplication({
                name: `Skills App ${suffix}`,
                organizationId: harness.organizationId,
                architecture: ApplicationArchitecture.WEB,
                url: "https://example.com",
                file: "s3://bucket/default-file.png",
            });

            const created = await harness.request().skills.create({
                applicationId: application.id,
                name: `Auth Helper ${suffix}`,
                description: "Knows how to authenticate",
                content: "Use the primary login form and wait for the dashboard.",
            });

            const list = await harness.request().skills.list({ applicationId: application.id });
            expect(list.map((skill) => skill.id)).toContain(created.id);

            const detail = await harness.request().skills.getBySlug({
                applicationId: application.id,
                slug: created.slug,
            });

            expect(detail.name).toBe(`Auth Helper ${suffix}`);
            expect(detail.content).toContain("primary login form");
        });

        test("imports multiple skills from markdown files", async ({ harness }) => {
            const suffix = randomUUID();
            const application = await harness.services.applications.createApplication({
                name: `Bulk Skills App ${suffix}`,
                organizationId: harness.organizationId,
                architecture: ApplicationArchitecture.WEB,
                url: "https://example.com",
                file: "s3://bucket/default-file.png",
            });

            const results = await harness.request().skills.createBulk({
                applicationId: application.id,
                file: [
                    new File(
                        [
                            "---\nname: Checkout flow\ndescription: Handles checkout data setup\n---\n\nUse cart-first navigation.",
                        ],
                        "checkout.md",
                        { type: "text/markdown" },
                    ),
                    new File(
                        [
                            "---\nname: Empty states\ndescription: Explains empty dashboard behavior\n---\n\nPrefer zero-data assertions first.",
                        ],
                        "empty-states.md",
                        { type: "text/markdown" },
                    ),
                ],
            });

            expect(results).toHaveLength(2);

            const list = await harness.request().skills.list({ applicationId: application.id });
            expect(list.map((skill) => skill.slug)).toEqual(expect.arrayContaining(["checkout-flow", "empty-states"]));
        });

        test("rejects bulk imports when frontmatter descriptions are missing", async ({ harness }) => {
            const suffix = randomUUID();
            const application = await harness.services.applications.createApplication({
                name: `Bulk Error App ${suffix}`,
                organizationId: harness.organizationId,
                architecture: ApplicationArchitecture.WEB,
                url: "https://example.com",
                file: "s3://bucket/default-file.png",
            });

            await expect(
                harness.request().skills.createBulk({
                    applicationId: application.id,
                    file: [
                        new File(["---\nname: Broken skill\n---\n\nMissing a description."], "broken.md", {
                            type: "text/markdown",
                        }),
                    ],
                }),
            ).rejects.toBeInstanceOf(TRPCError);
        });

        test("deletes a skill by slug", async ({ harness }) => {
            const suffix = randomUUID();
            const application = await harness.services.applications.createApplication({
                name: `Delete Skill App ${suffix}`,
                organizationId: harness.organizationId,
                architecture: ApplicationArchitecture.WEB,
                url: "https://example.com",
                file: "s3://bucket/default-file.png",
            });

            const created = await harness.request().skills.create({
                applicationId: application.id,
                name: `Delete Me ${suffix}`,
                description: "Temporary skill",
                content: "Delete this skill during the test.",
            });

            await harness.request().skills.delete({ applicationId: application.id, slug: created.slug });

            const remaining = await harness.request().skills.list({ applicationId: application.id });
            expect(remaining.map((skill) => skill.slug)).not.toContain(created.slug);
        });
    },
});
