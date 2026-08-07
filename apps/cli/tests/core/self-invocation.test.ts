import { describe, expect, test } from "vitest";
import { selfInvocation } from "../../src/core/self-invocation";

const NODE = "/usr/local/bin/node";

describe("selfInvocation", () => {
    /**
     * The reported bug: the CLI told people to run `autonoma-planner --resume`.
     * Practically everyone arrives through `npx`, which installs nothing on PATH, so
     * that is `command not found` at the moment they most need a command that works.
     */
    test("names the npx form when npx is how the run was reached", () => {
        const argv = [NODE, "/Users/dev/.npm/_npx/4f2a1/node_modules/@autonoma-ai/planner/dist/index.js"];

        expect(selfInvocation(argv, NODE)).toBe("npx @autonoma-ai/planner@latest");
    });

    /** A deliberate global install is the one case where the bare bin name is real. */
    test("names the bin when it is genuinely on PATH", () => {
        const argv = [NODE, "/usr/local/bin/autonoma-planner"];

        expect(selfInvocation(argv, NODE)).toBe("autonoma-planner");
    });

    /** A checkout or a bundled path has neither, so the script path is what works. */
    test("falls back to the script path for a local checkout", () => {
        const argv = [NODE, "/Users/dev/work/quarita/apps/cli/dist/index.js"];

        expect(selfInvocation(argv, NODE)).toBe(`${NODE} /Users/dev/work/quarita/apps/cli/dist/index.js`);
    });

    test("names the npx form rather than a broken command when there is no script path", () => {
        expect(selfInvocation([NODE], NODE)).toBe("npx @autonoma-ai/planner@latest");
    });
});
