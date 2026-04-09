import { describe, expect, it, vi } from "vitest";
import type { DiffsAgentCallbacks } from "../src/callbacks";
import { buildUpdateSkillTool } from "../src/tools/update-skill-tool";
import { createEmptyCollector } from "./create-collector";
import { executeTool } from "./execute-tool";

function createMockCallbacks(): DiffsAgentCallbacks {
    return {
        triggerTestsAndWait: vi.fn(),
        quarantineTest: vi.fn(),
        modifyTest: vi.fn(),
        updateSkill: vi.fn().mockResolvedValue(undefined),
        reportBug: vi.fn(),
    };
}

describe("update_skill tool", () => {
    it("updates a skill with new content", async () => {
        const callbacks = createMockCallbacks();
        const collector = createEmptyCollector();
        const tool = buildUpdateSkillTool(callbacks, collector);

        const result = await executeTool<{ success: boolean; skillId: string }>(tool, {
            skillId: "skill-1",
            skillName: "Login Flow",
            reasoning: "Login form fields changed",
            newContent:
                "# Login\n\n1. Navigate to /login\n2. Enter email in the 'Email address' field\n3. Click 'Continue'",
        });

        expect(result.success).toBe(true);
        expect(result.skillId).toBe("skill-1");
        expect(callbacks.updateSkill).toHaveBeenCalledWith(
            "skill-1",
            "# Login\n\n1. Navigate to /login\n2. Enter email in the 'Email address' field\n3. Click 'Continue'",
        );
        expect(collector.skillUpdates).toHaveLength(1);
    });

    it("does not require a prior test run", async () => {
        const callbacks = createMockCallbacks();
        const tool = buildUpdateSkillTool(callbacks, createEmptyCollector());

        const result = await executeTool<{ success: boolean }>(tool, {
            skillId: "skill-2",
            skillName: "Nav Flow",
            reasoning: "Navigation flow updated",
            newContent: "Updated content",
        });

        expect(result.success).toBe(true);
    });
});
