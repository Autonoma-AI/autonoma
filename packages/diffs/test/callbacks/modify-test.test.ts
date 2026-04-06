import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TestSuiteUpdater } from "@autonoma/test-updates";
import { expect } from "vitest";
import { modifyTest } from "../../src/callbacks/modify-test";
import { TestDirectory } from "../../src/test-directory";
import { createTestFixture } from "../setup-fixture";
import { diffsCallbackSuite } from "./harness";

diffsCallbackSuite({
    name: "modifyTest",
    cases: (test) => {
        test("applies UpdateTest via TestSuiteUpdater and writes file to disk", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const { branchId, testCaseId } = await harness.setupBranchWithTest(
                organizationId,
                applicationId,
                "login-flow",
                "Login Flow",
            );

            const updater = await TestSuiteUpdater.startUpdate({ db: harness.db, branchId });
            const fixture = await createTestFixture();

            try {
                await modifyTest(
                    { slug: "login-flow", newInstruction: "Click the new login button" },
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

                const filePath = join(fixture.workingDirectory, "autonoma", "qa-tests", "login-flow.md");
                const content = await readFile(filePath, "utf-8");
                expect(content).toContain("name: Login Flow");
                expect(content).toContain("Click the new login button");

                const plan = await harness.db.testPlan.findFirst({
                    where: { testCaseId },
                    orderBy: { createdAt: "desc" },
                });
                expect(plan?.prompt).toBe("Click the new login button");
            } finally {
                await fixture.cleanup();
            }
        });

        test("does nothing when test case is not found", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId);
            const updater = await TestSuiteUpdater.startUpdate({ db: harness.db, branchId });
            const fixture = await createTestFixture();

            try {
                await modifyTest(
                    { slug: "nonexistent", newInstruction: "whatever" },
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

                const plans = await harness.db.testPlan.findMany({
                    where: { testCase: { slug: "nonexistent" } },
                });
                expect(plans).toHaveLength(0);
            } finally {
                await fixture.cleanup();
            }
        });
    },
});
