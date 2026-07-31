import { AgentTool, FixableToolError, type TextGenerator, type UploadedVideo } from "@autonoma/ai";
import { causeMessage } from "@autonoma/errors";
import { z } from "zod";
import { truncateOutput } from "../../../agents/tools/truncate-output";

const MAX_CHARS = 16_000;

const analyzeVideoInputSchema = z.object({ question: z.string() });

type AnalyzeVideoInput = z.infer<typeof analyzeVideoInputSchema>;

class VideoReadFailedError extends FixableToolError {
    constructor(cause: unknown) {
        super(`Could not analyze the video: ${causeMessage(cause)}`);
    }

    override suggestFix(): string {
        return "Ask one narrower question about a specific moment. If that fails too, fall back to view_step_details on the steps that matter and the attached final screenshot rather than re-reading the whole recording.";
    }
}

/**
 * Ask the video model a specific question about the full run video (survey the whole run, including errors).
 *
 * Takes the recording itself, so this tool exists only for a run that HAS one - a run that recorded nothing
 * is not offered a video reader that can only refuse.
 */
export class AnalyzeVideoTool extends AgentTool<AnalyzeVideoInput, string> {
    constructor(
        private readonly reader: TextGenerator,
        private readonly recording: UploadedVideo,
    ) {
        super({
            name: "analyze_video",
            description:
                "Watch the run's full screen recording and answer a SPECIFIC question about it. Survey the WHOLE run, not just the blocking step: where the agent progressed AND every error state on screen (error toasts/banners, red text, 5xx, broken/blank renders, wrong responses) with the verbatim text and the action it followed (the recording's timing is compressed, so name the preceding step rather than a timestamp). Ask pointed questions (e.g. 'list every error message shown and after which action') rather than 'what happened'. Use this almost always. " +
                `The answer is capped at ${MAX_CHARS} characters, so ask for what you need rather than a full narration.`,
            inputSchema: analyzeVideoInputSchema,
        });
    }

    protected async execute({ question }: AnalyzeVideoInput): Promise<string> {
        try {
            const answer = await this.reader.generate({
                userPrompt: `${question}\n\nThis is the full screen recording of the run, start to finish.`,
                video: this.recording,
            });
            // Truncated head+tail with no narrow hint: re-running a vision call is expensive, so keep what
            // came back rather than asking the model to pay for the read again.
            return truncateOutput(answer, MAX_CHARS, "answer");
        } catch (cause) {
            throw new VideoReadFailedError(cause);
        }
    }
}
