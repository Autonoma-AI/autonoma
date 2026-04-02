import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TestSuiteUpdater } from "@autonoma/test-updates";
import { expect } from "vitest";
import { updateSkill } from "../../src/callbacks/update-skill";
import { TestDirectory } from "../../src/test-directory";
import { createTestFixture } from "../setup-fixture";
import { diffsCallbackSuite } from "./harness";

diffsCallbackSuite({
    name: "updateSkill",
    cases: (test) => {
        test("applies UpdateSkill via TestSuiteUpdater and writes file to disk", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const { branchId, skillId } = await harness.setupBranchWithSkill(
                organizationId,
                applicationId,
                "login-skill",
                "Login Skill",
                "Handles login flow",
            );

            const updater = await TestSuiteUpdater.startUpdate({ db: harness.db, branchId });
            const fixture = await createTestFixture();

            try {
                await updateSkill(
                    { skillId, newContent: "# Login\n\n1. Go to /login\n2. Enter credentials" },
                    {
                        db: harness.db,
                        updater,
                        applicationId,
                        testDirectory: await TestDirectory.create({
                            workingDirectory: fixture.workingDirectory,
                            tests: [],
                            skills: [],
                        }),
                    },
                );

                const filePath = join(fixture.workingDirectory, "autonoma", "skills", "login-skill.md");
                const content = await readFile(filePath, "utf-8");
                expect(content).toContain("name: Login Skill");
                expect(content).toContain("description: Handles login flow");
                expect(content).toContain("# Login");

                const plan = await harness.db.skillPlan.findFirst({
                    where: { skillId },
                    orderBy: { createdAt: "desc" },
                });
                expect(plan?.content).toBe("# Login\n\n1. Go to /login\n2. Enter credentials");
            } finally {
                await fixture.cleanup();
            }
        });

        test("does nothing when skill is not found", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);
            const updater = await TestSuiteUpdater.startUpdate({ db: harness.db, branchId });
            const fixture = await createTestFixture();

            try {
                await updateSkill(
                    { skillId: "nonexistent-id", newContent: "whatever" },
                    {
                        db: harness.db,
                        updater,
                        applicationId,
                        testDirectory: await TestDirectory.create({
                            workingDirectory: fixture.workingDirectory,
                            tests: [],
                            skills: [],
                        }),
                    },
                );

                const plans = await harness.db.skillPlan.findMany({
                    where: { skillId: "nonexistent-id" },
                });
                expect(plans).toHaveLength(0);
            } finally {
                await fixture.cleanup();
            }
        });
    },
});
