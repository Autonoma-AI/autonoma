import { AssertionSplitter } from "@autonoma/ai";
import { AssertCommand, DragCommand, MobileClickCommand, ScrollCommand, TypeCommand } from "@autonoma/engine";
import {
    AssertTool,
    ClickTool,
    type CommandTool,
    DragTool,
    type EngineModelRegistry,
    ExecutionAgentFactory,
    ScrollTool,
    TypeTool,
} from "@autonoma/engine";
import { AssertChecker, GeminiObjectDetector, ObjectPointDetector, VisualConditionChecker } from "@autonoma/visual-ai";
import type { MobileContext } from "../../platform";
import type { MobileCommandSpec } from "./mobile-agent-types";

function createTools(models: EngineModelRegistry): CommandTool<MobileCommandSpec, MobileContext>[] {
    const pointDetector = new ObjectPointDetector(
        new GeminiObjectDetector(models.getModel({ model: "smart-visual", tag: "point-detection" })),
    );
    const assertChecker = new AssertChecker(models.getModel({ model: "smart-visual", tag: "assert" }));
    const assertionSplitter = new AssertionSplitter(models.getModel({ model: "fast-text", tag: "assertion-splitter" }));
    const visualConditionChecker = new VisualConditionChecker({
        model: models.getModel({ model: "fast-visual", tag: "visual-condition-checker" }),
    });

    return [
        new ClickTool(new MobileClickCommand(pointDetector)),
        new DragTool(new DragCommand(pointDetector)),
        new TypeTool(new TypeCommand(pointDetector)),
        new AssertTool(new AssertCommand(assertChecker, assertionSplitter)),
        new ScrollTool(new ScrollCommand(pointDetector, visualConditionChecker)),
    ] as unknown as CommandTool<MobileCommandSpec, MobileContext>[];
}

export function createMobileAgentFactory(
    models: EngineModelRegistry,
): ExecutionAgentFactory<MobileCommandSpec, MobileContext> {
    return new ExecutionAgentFactory({
        model: models.getModel({ model: "smart-visual", tag: "agent-loop" }),
        commandTools: createTools(models),
        architecture: "mobile",
        platformMetadata: async ({ context }) => ({ platform: context.platform }),
    });
}
