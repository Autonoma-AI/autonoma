import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { buildFinishTool } from "../../src/agents/03-scenario-recipe/index";
import {
    parseScenario,
    renderScenarioTable,
    validateScenarioIsConcrete,
} from "../../src/agents/03-scenario-recipe/scenario-table";
import type { AgentResult } from "../../src/core/agent";

const CONCRETE_SCENARIO = `---
scenarios:
  - name: standard
entity_types:
  - name: User
    count: 2
  - name: Organization
    count: 1
---

# standard

| name | email |
| ---- | ----- |
| Alex Smith | alex@example.test |

Organization: Acme Corp
`;

describe("validateScenarioIsConcrete", () => {
    test("accepts fully concrete scenario data", () => {
        expect(validateScenarioIsConcrete(CONCRETE_SCENARIO)).toEqual([]);
    });

    test("rejects a {{token}} that Autonoma does not substitute", () => {
        const errors = validateScenarioIsConcrete(`| email | {{user_email}} |`);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain("{{user_email}}");
    });

    test("accepts the built-in run-identity tokens", () => {
        expect(validateScenarioIsConcrete(`| email | admin-{{testRunShortId}}@acme.test |`)).toEqual([]);
        expect(validateScenarioIsConcrete(`| externalId | {{testRunId}} |`)).toEqual([]);
    });

    test("rejects a bare {variable} placeholder", () => {
        const errors = validateScenarioIsConcrete(`email: {email}`);
        expect(errors[0]).toContain("bare {variable}");
    });

    test("rejects a leftover variable_fields block", () => {
        const errors = validateScenarioIsConcrete(`entity_types: []\nvariable_fields:\n  - token: x`);
        expect(errors.some((e) => e.includes("variable_fields block"))).toBe(true);
    });

    test("never throws - returns an array even for empty input", () => {
        expect(() => validateScenarioIsConcrete("")).not.toThrow();
        expect(validateScenarioIsConcrete("")).toEqual([]);
    });
});

describe("parseScenario / renderScenarioTable have no variable concept", () => {
    let tempDir: string;
    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), "test-scenario-concrete-"));
    });
    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test("parseScenario returns only scenarioNames + entityTypes", async () => {
        await writeFile(join(tempDir, "scenarios.md"), CONCRETE_SCENARIO, "utf-8");
        const parsed = await parseScenario(tempDir);
        expect(Object.keys(parsed).sort()).toEqual(["entityTypes", "scenarioNames"]);
        expect(parsed.entityTypes).toEqual([
            { name: "User", count: 2 },
            { name: "Organization", count: 1 },
        ]);
    });

    test("rendered table has no Variable fields column", async () => {
        await writeFile(join(tempDir, "scenarios.md"), CONCRETE_SCENARIO, "utf-8");
        const parsed = await parseScenario(tempDir);
        const table = renderScenarioTable(parsed);
        expect(table).not.toContain("Variable fields");
        expect(table).toContain("Entity");
        expect(table).toContain("Count");
    });
});

describe("finish gate is non-fatal and hands errors back to the agent", () => {
    let tempDir: string;
    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), "test-finish-"));
    });
    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    async function runFinish(content: string, requiredEntities: string[]) {
        await writeFile(join(tempDir, "scenarios.md"), content, "utf-8");
        let captured: AgentResult | undefined;
        const finish = buildFinishTool(requiredEntities, tempDir, (r) => {
            captured = r;
        });
        const input = { summary: "s", entityCount: 2, artifacts: ["scenarios.md"] };
        // tool() exposes the execute we passed as a typed public property.
        const execute = finish.execute;
        if (execute == null) throw new Error("finish tool is missing an execute handler");
        const result = await execute(input, { toolCallId: "test", messages: [], context: {} });
        const error = result != null && "error" in result ? result.error : undefined;
        const success = result != null && "success" in result ? result.success : undefined;
        return { result: { error, success }, captured };
    }

    test("returns an error (not a throw) when a placeholder is present", async () => {
        const { result, captured } = await runFinish(`${CONCRETE_SCENARIO}\nadmin: {{admin_email}}`, [
            "User",
            "Organization",
        ]);
        expect(result.error).toContain("concrete");
        expect(result.success).toBeUndefined();
        expect(captured).toBeUndefined(); // did not finish
    });

    test("succeeds on a fully concrete scenario", async () => {
        const { result, captured } = await runFinish(CONCRETE_SCENARIO, ["User", "Organization"]);
        expect(result.success).toBe(true);
        expect(result.error).toBeUndefined();
        expect(captured?.success).toBe(true);
    });
});
