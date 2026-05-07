import type { NavigateCommandContext, NavigateCommandSpec } from "../../../../commands";
import { CommandTool } from "../command-tool";

export class NavigateTool extends CommandTool<NavigateCommandSpec, NavigateCommandContext> {
    protected inputSchema() {
        return this.command.paramsSchema;
    }

    description(): string {
        return [
            "Navigate directly to a URL. LAST RESORT ONLY.",
            "Always prefer using the UI (clicking links, buttons, menus) to reach pages - that is how you find real bugs.",
            "Only use this if: (1) you know the exact path of something AND cannot reach it through the UI,",
            "or (2) you already tested the UI navigation to this page in this same test and need to return efficiently.",
            "Accepts a full URL, a URL without protocol (https:// is added), or a relative path (resolved against the current page).",
        ].join(" ");
    }

    protected async extractParams(input: NavigateCommandSpec["params"]) {
        return { url: input.url };
    }
}
