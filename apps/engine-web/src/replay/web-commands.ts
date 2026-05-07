import {
    AssertChecker,
    AssertionSplitter,
    GeminiObjectDetector,
    ObjectPointDetector,
    VisualConditionChecker,
} from "@autonoma/ai";
import type { Command } from "@autonoma/engine";
import {
    AssertCommand,
    NavigateCommand,
    RefreshCommand,
    ScrollCommand,
    TypeCommand,
    WebClickCommand,
    WebHoverCommand,
} from "@autonoma/engine";
import type { EngineModelRegistry } from "@autonoma/engine";
import type { WebContext } from "../platform";
import type { ReplayWebCommandSpec } from "./web-command-spec";

/**
 * Create all web replay commands with their AI dependencies.
 *
 * The return type cast is intentional: each command carries its own specific TSpec/TContext,
 * but at runtime WebContext satisfies every specific command context, so the cast is safe.
 */
export function createWebCommands(models: EngineModelRegistry): Command<ReplayWebCommandSpec, WebContext>[] {
    const pointDetector = new ObjectPointDetector(
        new GeminiObjectDetector(models.getModel({ model: "smart-visual", tag: "point-detection" })),
    );
    const assertChecker = new AssertChecker(models.getModel({ model: "smart-visual", tag: "assert" }));
    const assertionSplitter = new AssertionSplitter(models.getModel({ model: "fast-text", tag: "assertion-splitter" }));
    const visualConditionChecker = new VisualConditionChecker({
        model: models.getModel({ model: "fast-visual", tag: "visual-condition-checker" }),
    });

    return [
        new WebClickCommand(pointDetector),
        new WebHoverCommand(pointDetector),
        new TypeCommand(pointDetector),
        new AssertCommand(assertChecker, assertionSplitter),
        new ScrollCommand(pointDetector, visualConditionChecker),
        new NavigateCommand(),
        new RefreshCommand(),
    ] as unknown as Command<ReplayWebCommandSpec, WebContext>[];
}
