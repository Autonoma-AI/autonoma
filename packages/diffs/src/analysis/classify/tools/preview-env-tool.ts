import { AgentTool, declinable, FixableToolError } from "@autonoma/ai";
import { causeMessage } from "@autonoma/errors";
import { z } from "zod";
import { truncateOutput } from "../../../agents/tools/truncate-output";
import type { PreviewEnvAccess } from "../types";

const MAX_CHARS = 16_000;

const previewEnvInputSchema = z.object({
    filter: declinable(z.string().min(1)).describe(
        "case-insensitive substring to filter var names by, e.g. a provider name or 'KEY'. Pass null to list every var.",
    ),
});

type PreviewEnvInput = z.infer<typeof previewEnvInputSchema>;

class PreviewEnvUnreadableError extends FixableToolError {
    constructor(cause: unknown) {
        super(`Could not read the preview's configured env: ${causeMessage(cause)}`);
    }

    override suggestFix(): string {
        return "Proceed without it, but do NOT assert whether a key, flag, or integration is configured - that claim now has no evidence behind it.";
    }
}

/** Which env vars the preview has configured (presence diagnoses a missing key/flag/integration). */
export class PreviewEnvTool extends AgentTool<PreviewEnvInput, string> {
    constructor(private readonly preview: PreviewEnvAccess) {
        super({
            name: "get_preview_env",
            description:
                "List the environment-variable NAMES THIS PR's preview deployment runs with - both the app's stored secrets and the keys its deployed config wires in from the topology (values masked). Decisive for config/flag gaps: if a third-party SDK / integration key is ABSENT from this list, that SDK never initializes, so anything it gates falls back to its code default - often OFF. Check here before blaming the scenario for a config/flag-gated redirect or a missing integration. " +
                `Output is capped at ${MAX_CHARS} characters; pass a filter to see a narrower list.`,
            inputSchema: previewEnvInputSchema,
        });
    }

    protected async execute({ filter }: PreviewEnvInput): Promise<string> {
        const names = await this.readNames(this.preview.getEnvVarNames(filter));
        const matching = filter != null ? ` matching "${filter}"` : "";

        // An empty list is a real FINDING - the prompt treats an absent integration key as decisive evidence
        // that whatever it gates fell back to its code default - so it stays a result, spelled out.
        if (names.length === 0) {
            return `No env var${matching} is configured in this preview - neither in the app's secret bundle nor among the keys its deployed config wires in from the topology. That integration is unconfigured here, so anything it gates falls back to code defaults.`;
        }

        const listing = names.map((name) => `- ${name}`).join("\n");
        return truncateOutput(
            `Env var NAMES the preview pod runs with${matching} - the app's secret bundle plus the keys this PR's deployed config wires in (values masked; a wired key's value is templated per-PR and is not readable here):\n${listing}`,
            MAX_CHARS,
            "env list",
            "Re-call get_preview_env with a filter to see less.",
        );
    }

    private async readNames(pending: Promise<string[]>): Promise<string[]> {
        try {
            return await pending;
        } catch (cause) {
            throw new PreviewEnvUnreadableError(cause);
        }
    }
}
