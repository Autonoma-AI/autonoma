import { describe, expect, it } from "vitest";
import { buildSections } from "./snapshot-entries";
import type { CreatedTest, SnapshotChange } from "./snapshot-types";

const NEW_TEST_CASE = { id: "tc-2", name: "Guest checkout", slug: "guest-checkout", folderId: "folder-1" };

function addedChange(): SnapshotChange {
    return {
        type: "added",
        testCaseId: NEW_TEST_CASE.id,
        testCaseName: NEW_TEST_CASE.name,
        testCaseSlug: NEW_TEST_CASE.slug,
        testCaseFolderId: NEW_TEST_CASE.folderId,
        plan: "change plan",
    };
}

function createdTest(): CreatedTest {
    return {
        testCase: NEW_TEST_CASE,
        description: "A guest user can complete checkout without signing in and reach the order confirmation page.",
        plan: "authored plan",
        generation: { id: "gen-new", status: "success" },
    };
}

describe("buildSections - created tests", () => {
    it("surfaces the coverage justification and generation inspector for an added test", () => {
        const sections = buildSections({
            changes: [addedChange()],
            createdTests: [createdTest()],
        });

        const entry = sections.find((s) => s.title === "Added")?.entries.find((e) => e.urlId === NEW_TEST_CASE.id);
        expect(entry?.reasoning).toBe(
            "A guest user can complete checkout without signing in and reach the order confirmation page.",
        );
        expect(entry?.plan).toBe("authored plan");
        expect(entry?.generation?.id).toBe("gen-new");
    });

    it("falls back to the change plan when no created-test record exists (legacy snapshot)", () => {
        const sections = buildSections({
            changes: [addedChange()],
            createdTests: [],
        });

        const entry = sections.find((s) => s.title === "Added")?.entries.find((e) => e.urlId === NEW_TEST_CASE.id);
        expect(entry?.plan).toBe("change plan");
        expect(entry?.reasoning).toBeUndefined();
        expect(entry?.generation).toBeUndefined();
    });
});
