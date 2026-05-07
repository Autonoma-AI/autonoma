import type { BaseCommandContext, NavigationDriver } from "../../../platform";
import { Command } from "../../command";
import type { CommandParams } from "../../command-spec";
import { type NavigateCommandSpec, navigateParamsSchema } from "./navigate.def";

export interface NavigateCommandContext extends BaseCommandContext {
    navigation: NavigationDriver;
}

export class NavigateCommand extends Command<NavigateCommandSpec, NavigateCommandContext> {
    public readonly interaction = "navigate" as const;
    public readonly paramsSchema = navigateParamsSchema;

    async execute(
        params: CommandParams<NavigateCommandSpec>,
        { navigation }: NavigateCommandContext,
    ): Promise<NavigateCommandSpec["output"]> {
        const currentUrl = await navigation.getCurrentUrl();
        const normalizedUrl = this.normalizeUrl(params.url, currentUrl);

        this.logger.info("Executing navigate command", { rawUrl: params.url, normalizedUrl, currentUrl });

        await navigation.navigate(normalizedUrl);

        const finalUrl = await navigation.getCurrentUrl();
        this.logger.info("Navigation complete", { finalUrl });

        return {
            outcome: `Navigated to ${finalUrl}`,
            url: finalUrl,
        };
    }

    private normalizeUrl(rawUrl: string, currentUrl: string): string {
        const trimmed = rawUrl.trim();

        if (trimmed.startsWith("/")) {
            const origin = new URL(currentUrl).origin;
            return `${origin}${trimmed}`;
        }

        if (!trimmed.includes("://")) {
            return `https://${trimmed}`;
        }

        return trimmed;
    }
}
