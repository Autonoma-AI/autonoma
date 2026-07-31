import { AgentLoop, type AgentConfig, type ModelMessage } from "@autonoma/ai";
import type { ApplicationArchitecture } from "@autonoma/db";
import type { CodebaseLoop } from "../../agents/tools/codebase/codebase-loop";
import type { InspectableStep, ScreenshotLoader } from "../../agents/tools/run-evidence/run-evidence-types";
import type { StepInspectionLoop } from "../../agents/tools/run-evidence/step-inspection-loop";
import type { Codebase } from "../../codebase";
import type { RunVerdict } from "../schema";
import type { RunArtifacts } from "./types";

interface ClassifierAgentLoopParams extends AgentConfig<RunVerdict> {
    codebase: Codebase;
    run: RunArtifacts;
    screenshotLoader: ScreenshotLoader;
}

/**
 * Per-run STATE for the classifier - the run under classification, and nothing else it could have been given.
 *
 * Dependencies do not live here. A tool that needs a capability takes it in its constructor: the ones fixed for
 * the agent's lifetime are built once, the ones belonging to a single run are built in `createLoop`. That is
 * what lets those tools treat their capability as non-optional, instead of each re-deriving "do I have one?"
 * from a field that might be undefined.
 *
 * `codebase`, and `screenshotLoader`/`steps`/`architecture`, are the exceptions, and not by choice: the
 * SHARED `bash` and `view_step_details` tools are typed against loop-shaped capability interfaces
 * ({@link CodebaseLoop}, {@link StepInspectionLoop}), so they read those off the loop. Changing that means
 * changing contracts the Reporter, healing and subagent tools also depend on.
 */
export class ClassifierAgentLoop extends AgentLoop<RunVerdict> implements CodebaseLoop, StepInspectionLoop {
    public readonly codebase: Codebase;
    /** The browser run under classification - its trace, its recording, its final frame, its per-step record. */
    public readonly run: RunArtifacts;
    /** Rehydrates one step frame for `view_step_details`; the keys live on {@link steps}. */
    public readonly screenshotLoader: ScreenshotLoader;

    constructor({ codebase, run, screenshotLoader, ...config }: ClassifierAgentLoopParams) {
        super(config);
        this.codebase = codebase;
        this.run = run;
        this.screenshotLoader = screenshotLoader;
    }

    /**
     * The steps `view_step_details` discloses, keyed by the trace `order` the prompt renders. The same array
     * {@link run} carries - exposed under the name {@link StepInspectionLoop} asks for rather than copied, so
     * the two can never disagree about which steps exist.
     */
    public get steps(): InspectableStep[] {
        return this.run.inspectableSteps;
    }

    /** Gates click-point annotation to the platform whose points share a coordinate space with the frame. */
    public get architecture(): ApplicationArchitecture | undefined {
        return this.run.architecture;
    }

    /**
     * Prepends the user prompt's TEXT to the transcript the caller persists.
     *
     * This is load-bearing rather than nostalgia: the four deterministic vision probes are non-deterministic
     * generations that exist ONLY in that prompt, and they are usually the key artifact when debugging a bad
     * verdict - without the prepend they are irrecoverable. Which is exactly why this hangs off
     * `buildTranscript` rather than wrapping `runLoop`: the loop applies it to failures too, and a run that
     * died is the one whose probes someone will want to read.
     *
     * Only text is carried over. The prompt's other part is the run's final frame, a raw `Uint8Array` that has
     * no business in persisted JSON; it reaches the report as a signed key on the finding instead.
     */
    protected override buildTranscript(userPrompt: ModelMessage[], modelMessages: ModelMessage[]): ModelMessage[] {
        return [{ role: "user", content: textOf(userPrompt) }, ...modelMessages];
    }
}

/** Every text part of a prompt, concatenated - the prompt minus its media, for the persisted transcript. */
function textOf(messages: ModelMessage[]): string {
    const texts: string[] = [];
    for (const message of messages) {
        if (typeof message.content === "string") {
            texts.push(message.content);
            continue;
        }
        for (const part of message.content) {
            if (part.type === "text") texts.push(part.text);
        }
    }
    return texts.join("\n");
}
