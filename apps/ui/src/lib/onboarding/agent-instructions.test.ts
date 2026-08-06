import { describe, expect, it } from "vitest";
import { sdkFixInstruction } from "./agent-instructions";

describe("sdkFixInstruction", () => {
    it("starts the agent on the failure rather than on 'fix it if it fails'", () => {
        const instruction = sdkFixInstruction("SDK returned HTTP 404: Autonoma endpoint is disabled in production");
        expect(instruction).toContain("autonoma MCP");
        expect(instruction).toContain("Autonoma endpoint is disabled in production");
        expect(instruction).not.toContain("fix it if it fails");
    });

    it("collapses a multi-line error, which would otherwise split the launch command in two", () => {
        const instruction = sdkFixInstruction("SDK returned HTTP 500:\n  at handler (app/api/autonoma/route.ts:12)");
        expect(instruction).not.toContain("\n");
    });

    it("truncates an error long enough to bury the command it sits in", () => {
        const instruction = sdkFixInstruction(`SDK returned HTTP 400: ${"model ".repeat(200)}`);
        expect(instruction).toContain("...");
        expect(instruction.length).toBeLessThan(300);
    });
});
