import { AgentTool, type AgentToolModelOutput, type AgentToolModelOutputOptions } from "@autonoma/ai";
import { z } from "zod";
import type { ReporterAgentLoop } from "../reporter-agent-loop";

const inputSchema = z.object({
    assetId: z
        .string()
        .describe("The assetId of the screenshot to inspect - one of the screenshot ids listed under a finding."),
});

type FetchEvidenceInput = z.infer<typeof inputSchema>;

type FetchEvidenceOutput = { assetId: string; label: string; base64: string };

const DESCRIPTION =
    "Fetch one finding's screenshot as an inline image so you can see what the app actually looked like. Pass the assetId listed under a finding. Once fetched, its `evidence:<assetId>` token becomes embeddable in an issue narrative or the report - `![caption](evidence:<assetId>)`. Only a screenshot you fetch this way can be embedded or set as an issue's hero; an id you never fetched is dropped. Fetch only what you need to ground a bug - do not sweep every screenshot.";

/**
 * On-demand screenshot fetch for the Reporter. Delegates to {@link ReporterAgentLoop.fetchEvidence}, which loads
 * the bytes and mints the asset's `evidence:<assetId>` token on the run's allow-list (throwing a fixable error for
 * an unknown id or bytes that will not load - both are errors the model must handle, not a successful empty
 * fetch). The tool only shapes the loaded bytes into inline vision via {@link AgentTool.toModelOutput}.
 */
export class FetchEvidenceTool extends AgentTool<FetchEvidenceInput, FetchEvidenceOutput, ReporterAgentLoop> {
    constructor() {
        super({ name: "fetch_evidence", description: DESCRIPTION, inputSchema });
    }

    protected async execute({ assetId }: FetchEvidenceInput, loop: ReporterAgentLoop): Promise<FetchEvidenceOutput> {
        const { label, base64 } = await loop.fetchEvidence(assetId);
        return { assetId, label, base64 };
    }

    protected override toModelOutput({
        output,
    }: AgentToolModelOutputOptions<FetchEvidenceInput, FetchEvidenceOutput>): AgentToolModelOutput<
        FetchEvidenceInput,
        FetchEvidenceOutput
    > {
        if (!output.success) return { type: "error-json", value: toErrorJson(output) };

        const out = output.result;
        return {
            type: "content",
            value: [
                { type: "text", text: `Screenshot ${out.assetId} (${out.label}):` },
                { type: "media", data: out.base64, mediaType: "image/png" },
                {
                    type: "text",
                    text: `To embed this screenshot, use \`![caption](evidence:${out.assetId})\` - only this fetched id is valid.`,
                },
            ],
        };
    }
}

function toErrorJson(output: { error: string; fixSuggestion?: string }) {
    return output.fixSuggestion == null
        ? { success: false, error: output.error }
        : { success: false, error: output.error, fixSuggestion: output.fixSuggestion };
}
