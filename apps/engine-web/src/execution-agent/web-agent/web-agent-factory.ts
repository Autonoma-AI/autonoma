import {
    AssertChecker,
    AssertionSplitter,
    GeminiObjectDetector,
    ObjectPointDetector,
    TextExtractor,
    VisualConditionChecker,
} from "@autonoma/ai";
import {
    AssertCommand,
    DragCommand,
    NavigateCommand,
    ReadCommand,
    RefreshCommand,
    SaveClipboardCommand,
    ScrollCommand,
    TypeCommand,
    WebClickCommand,
    WebHoverCommand,
} from "@autonoma/engine";
import {
    AssertTool,
    ClickTool,
    type CommandTool,
    DragTool,
    type EngineModelRegistry,
    ExecutionAgentFactory,
    HoverTool,
    NavigateTool,
    ReadTool,
    RefreshTool,
    SaveClipboardTool,
    ScrollTool,
    TypeTool,
    WaitPlanner,
} from "@autonoma/engine";
import type { WebCommandSpec } from ".";
import type { WebContext } from "../../platform";

/**
 * Create the command tools available to the agent.
 *
 * The return type cast is intentional: each tool carries its own specific TSpec/TContext,
 * but at runtime WebContext satisfies every specific command context, so the cast is safe.
 */
function createTools(models: EngineModelRegistry): CommandTool<WebCommandSpec, WebContext>[] {
    const pointDetector = new ObjectPointDetector(
        new GeminiObjectDetector(models.getModel({ model: "smart-visual", tag: "point-detection" })),
    );
    const assertChecker = new AssertChecker(models.getModel({ model: "smart-visual", tag: "assert" }));
    const assertionSplitter = new AssertionSplitter(models.getModel({ model: "fast-text", tag: "assertion-splitter" }));
    const visualConditionChecker = new VisualConditionChecker({
        model: models.getModel({ model: "fast-visual", tag: "visual-condition-checker" }),
    });
    const textExtractor = new TextExtractor(models.getModel({ model: "smart-visual", tag: "text-extraction" }));

    return [
        new ClickTool(new WebClickCommand(pointDetector)),
        new HoverTool(new WebHoverCommand(pointDetector)),
        new DragTool(new DragCommand(pointDetector)),
        new TypeTool(new TypeCommand(pointDetector)),
        new AssertTool(new AssertCommand(assertChecker, assertionSplitter)),
        new ScrollTool(new ScrollCommand(pointDetector, visualConditionChecker)),
        new NavigateTool(new NavigateCommand()),
        new RefreshTool(new RefreshCommand()),
        new ReadTool(new ReadCommand(textExtractor)),
        new SaveClipboardTool(new SaveClipboardCommand()),
    ] as unknown as CommandTool<WebCommandSpec, WebContext>[];
}

export function createWebAgentFactory(models: EngineModelRegistry): ExecutionAgentFactory<WebCommandSpec, WebContext> {
    return new ExecutionAgentFactory({
        model: models.getModel({ model: "smart-visual", tag: "agent-loop" }),
        commandTools: createTools(models),
        waitPlanner: new WaitPlanner<WebCommandSpec>({
            model: models.getModel({ model: "fast-visual", tag: "wait-planner" }),
        }),
        waitConditionValidator: new VisualConditionChecker({
            model: models.getModel({ model: "fast-visual", tag: "wait-condition-validator" }),
        }),
        architecture: "web",
        platformMetadata: async ({ context }) => ({
            url: await context.navigation.getCurrentUrl(),
        }),
    });
}
