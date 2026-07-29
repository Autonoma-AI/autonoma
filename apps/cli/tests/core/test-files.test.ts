import { describe, expect, test } from "vitest";
import { isTestFile, normalizeTestFilename, TEST_INDEX_FILE } from "../../src/core/test-files";

describe("the generated-test file contract", () => {
    test("a filename the model forgot to extend still lands as markdown", () => {
        // The whole pipeline finds tests by extension; a bare name would exist
        // on disk while never being uploaded, reviewed, or counted.
        expect(normalizeTestFilename("login-valid-credentials")).toBe("login-valid-credentials.md");
    });

    test("near-miss extensions are corrected rather than doubled up", () => {
        expect(normalizeTestFilename("login.markdown")).toBe("login.md");
        expect(normalizeTestFilename("login.mdx")).toBe("login.md");
        expect(normalizeTestFilename("  login.md  ")).toBe("login.md");
    });

    test("a name that is already right is left alone, dots and all", () => {
        expect(normalizeTestFilename("v1.2-checkout.md")).toBe("v1.2-checkout.md");
    });

    test("the index is not a test, wherever it sits", () => {
        expect(isTestFile(TEST_INDEX_FILE)).toBe(false);
        expect(isTestFile("qa-tests/INDEX.md")).toBe(false);
        expect(isTestFile("qa-tests/account/edit-profile.md")).toBe(true);
    });

    test("non-markdown files are not tests", () => {
        expect(isTestFile("qa-tests/.bfs-state.json")).toBe(false);
        expect(isTestFile("qa-tests/notes.txt")).toBe(false);
    });
});
