import { describe, expect, test } from "vitest";
import { formatEntityTable, findEnumGaps, formatEnumGaps } from "../../src/agents/03-scenario-recipe/display";

describe("formatEntityTable", () => {
    test("handles empty records", () => {
        expect(formatEntityTable("User", [])).toBe("User: (no records)");
    });

    test("formats a simple table", () => {
        const records = [
            { name: "Alice", email: "alice@example.com" },
            { name: "Bob", email: "bob@example.com" },
        ];
        const result = formatEntityTable("User", records);
        expect(result).toContain("User (2 records)");
        expect(result).toContain("name");
        expect(result).toContain("email");
        expect(result).toContain("Alice");
        expect(result).toContain("Bob");
    });

    test("pads columns to max width", () => {
        const records = [
            { id: "1", name: "Al" },
            { id: "2", name: "Alexander" },
        ];
        const result = formatEntityTable("Person", records);
        const lines = result.split("\n");
        const headerLine = lines[1];
        const separatorLine = lines[2];
        expect(headerLine).toContain("name     ");
        expect(separatorLine).toContain("-+-");
    });

    test("handles null/undefined values", () => {
        const records = [{ name: "Alice", bio: null }];
        const result = formatEntityTable("Profile", records);
        expect(result).toContain("Profile (1 records)");
    });
});

describe("findEnumGaps", () => {
    test("returns empty when all values covered", () => {
        const records = [{ status: "active" }, { status: "inactive" }];
        const gaps = findEnumGaps(records, { status: ["active", "inactive"] });
        expect(gaps).toHaveLength(0);
    });

    test("detects missing values", () => {
        const records = [{ status: "active" }];
        const gaps = findEnumGaps(records, { status: ["active", "inactive", "banned"] });
        expect(gaps).toHaveLength(1);
        expect(gaps[0]!.field).toBe("status");
        expect(gaps[0]!.covered).toEqual(["active"]);
        expect(gaps[0]!.missing).toEqual(["inactive", "banned"]);
    });

    test("handles multiple enum fields", () => {
        const records = [{ status: "active", role: "admin" }];
        const gaps = findEnumGaps(records, {
            status: ["active", "inactive"],
            role: ["admin", "member", "guest"],
        });
        expect(gaps).toHaveLength(2);
        const statusGap = gaps.find((g) => g.field === "status");
        const roleGap = gaps.find((g) => g.field === "role");
        expect(statusGap?.missing).toEqual(["inactive"]);
        expect(roleGap?.missing).toEqual(["member", "guest"]);
    });

    test("ignores non-string field values", () => {
        const records = [{ status: 123 }];
        const gaps = findEnumGaps(records, { status: ["active", "inactive"] });
        expect(gaps).toHaveLength(1);
        expect(gaps[0]!.covered).toHaveLength(0);
        expect(gaps[0]!.missing).toEqual(["active", "inactive"]);
    });

    test("returns empty for no enum fields", () => {
        const gaps = findEnumGaps([{ name: "test" }], {});
        expect(gaps).toHaveLength(0);
    });
});

describe("formatEnumGaps", () => {
    test("returns all-covered message when no gaps", () => {
        expect(formatEnumGaps([])).toBe("  All enum values covered");
    });

    test("formats gaps with covered and missing markers", () => {
        const result = formatEnumGaps([{ field: "status", covered: ["active"], missing: ["inactive", "banned"] }]);
        expect(result).toContain("status:");
        expect(result).toContain("active +");
        expect(result).toContain("inactive -");
        expect(result).toContain("banned -");
        expect(result).toContain("missing: inactive, banned");
    });
});

describe("the write_test dashboard mirror", () => {
    test("records the path write_test actually wrote, normalization included", async () => {
        const { createStepLogger } = await import("../../src/core/display");
        const { createStore, setActiveStore } = await import("../../src/ui/store");

        const store = createStore({ outputDir: "/out", meta: { title: "t", project: "p", version: "0" } });
        setActiveStore(store);
        try {
            const logger = createStepLogger("test-generator", 50);
            // The model omitted the extension; write_test normalizes it, so a
            // mirror that trusted the raw name would list a nonexistent file.
            logger.log({
                stepNumber: 1,
                maxSteps: 50,
                text: "",
                toolCalls: [
                    { name: "write_test", input: { folder: "account", filename: "edit-profile", nodeId: "n1" } },
                ],
                toolErrors: [],
                writtenFiles: [],
            });

            const paths = store.getState().artifactOrder;
            expect(paths).toContain("qa-tests/account/edit-profile.md");
            expect(paths).not.toContain("qa-tests/account/edit-profile");
        } finally {
            setActiveStore(undefined);
        }
    });
});
