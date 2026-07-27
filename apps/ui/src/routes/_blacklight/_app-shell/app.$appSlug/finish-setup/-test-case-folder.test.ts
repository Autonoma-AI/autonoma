import { describe, expect, test } from "vitest";
import { testCaseFolder } from "./-test-case-folder";

describe("testCaseFolder", () => {
    test("strips a leading qa-tests/ segment so it matches the CLI's key", () => {
        expect(testCaseFolder("qa-tests/dashboard/cards/create-physical-card.md")).toBe("dashboard/cards");
    });

    test("strips an autonoma/qa-tests/ prefix too (the app-dir layout)", () => {
        expect(testCaseFolder("autonoma/qa-tests/dashboard/cards/create-physical-card.md")).toBe("dashboard/cards");
    });

    test("returns undefined for a test sitting directly under qa-tests/", () => {
        expect(testCaseFolder("qa-tests/smoke.md")).toBeUndefined();
    });

    test("handles nested journeys", () => {
        expect(testCaseFolder("qa-tests/journeys/full-financial-cycle.md")).toBe("journeys");
    });

    test("a manual folder-upload path and a CLI-relative path resolve to the SAME key", () => {
        // The API dedupes on (folder, name); if the two producers disagree on the folder,
        // a manual upload and a CLI run store the same test case twice.
        const fromDirUpload = testCaseFolder("autonoma/qa-tests/dashboard/cards/create-physical-card.md");
        const fromCli = testCaseFolder("dashboard/cards/create-physical-card.md");
        expect(fromDirUpload).toBe(fromCli);
        expect(fromDirUpload).toBe("dashboard/cards");
    });

    test("falls back to the whole dir when there is no qa-tests/ marker", () => {
        expect(testCaseFolder("dashboard/cards/create-physical-card.md")).toBe("dashboard/cards");
    });

    test("matches qa-tests as a whole segment, not a substring", () => {
        // A dir merely ending in `qa-tests` must not be mistaken for the marker.
        expect(testCaseFolder("my-qa-tests/dashboard/cards/create-physical-card.md")).toBe(
            "my-qa-tests/dashboard/cards",
        );
    });
});
