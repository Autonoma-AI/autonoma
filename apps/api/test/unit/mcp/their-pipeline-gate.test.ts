import { describe, expect, it } from "vitest";
import { assertTheirPipelineIsAllowed } from "../../../src/mcp/their-pipeline-gate";

const ON_VERCEL = { installed: true, linked: true };
const OFF_VERCEL = { installed: false, linked: false };
const QUOTED_REQUEST = "we already have previews per PR, can we just use those?";

describe("assertTheirPipelineIsAllowed", () => {
    it("allows a Vercel project once the user has chosen it", () => {
        expect(() => assertTheirPipelineIsAllowed(ON_VERCEL, QUOTED_REQUEST)).not.toThrow();
    });

    it("allows a non-Vercel project too - the user's own previews are not Vercel-only", () => {
        expect(() => assertTheirPipelineIsAllowed(OFF_VERCEL, QUOTED_REQUEST)).not.toThrow();
    });

    it("refuses on Vercel until the user has actually chosen, and says to ask", () => {
        expect(() => assertTheirPipelineIsAllowed(ON_VERCEL, undefined)).toThrow(/the user's call/);
    });

    it("refuses off Vercel and says not to raise it unprompted", () => {
        expect(() => assertTheirPipelineIsAllowed(OFF_VERCEL, undefined)).toThrow(/do not offer this/);
    });

    it("does not let an unreadable Vercel state block a choice the user already made", () => {
        expect(() =>
            assertTheirPipelineIsAllowed({ installed: false, linked: false, unresolved: true }, QUOTED_REQUEST),
        ).not.toThrow();
    });
});
