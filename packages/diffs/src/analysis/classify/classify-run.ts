import { logger as rootLogger } from "@autonoma/logger";
import { Output, generateText, stepCountIs } from "ai";
import { withRetry } from "../retry";
import type { RunVerdict } from "../schema";
import type { ClassifierDeps } from "./dependencies";
import {
    CLASSIFIER_SYSTEM_PROMPT,
    ERROR_PROBE_PROMPT,
    FIDELITY_PROBE_PROMPT,
    VISUAL_SANITY_PROBE_PROMPT,
    buildVerdictPrompt,
} from "./prompt";
import { buildClassifierTools, describeUnavailableTools } from "./tools";
import { VerdictForModel, toRunVerdict } from "./verdict-schema";

/** The static facts about the run being classified (the injected capabilities live in ClassifierDeps). */
export interface ClassifyContext {
    appSlug: string;
    prNumber: number;
    test: { slug: string; plan: string; affectedReason: string };
    provision: { status: string; detail: string; seeded?: string };
    /** A short diff stat for context (the full diff is available via the git_diff tool). */
    diffSummary: string;
    /** The PR author's stated intent - decisive for telling an intended change from a bug. */
    prTitle?: string;
    prBody?: string;
}

const INVESTIGATION_TIMEOUT_MS = 12 * 60_000;
const VERDICT_TIMEOUT_MS = 6 * 60_000;
const PROBE_TIMEOUT_MS = 3 * 60_000;

/** Prepended to every VIDEO probe: the agent reasons between actions, so the view sits static by design. */
const VIDEO_SCAN_GUIDANCE =
    "This is a screen recording of an automated test agent that PAUSES TO REASON between actions, so the screen frequently stays on ONE static view for many seconds with no visible change - that is the agent thinking, NOT the end of the run. Watch the ENTIRE recording from the first frame to the last before answering; never assume nothing happened or that the run stopped just because a view is static for a while. Account for everything that appears across the full timeline, including screens that appear only briefly.";
const PR_BODY_LIMIT = 1500;

type VisionMedia = { type: "file"; data: Uint8Array; mediaType: string } | { type: "image"; image: Uint8Array };

/** Pick the best media to scan: the full video if we have it, else the final screenshot. */
function runMedia(run: ClassifierDeps["run"]): VisionMedia | undefined {
    if (run.video != null) return { type: "file", data: run.video, mediaType: "video/webm" };
    if (run.finalScreenshot != null) return { type: "image", image: run.finalScreenshot };
    return undefined;
}

/**
 * A deterministic vision pass over the run media - the "always ask plainly, then dig" pattern. The error
 * and fidelity probes run BEFORE the classifier reasons, so the two signals it most often gets wrong
 * (on-screen errors, did-the-run-follow-the-plan) are surfaced as fact instead of left to its discretion.
 */
async function visionProbe(deps: ClassifierDeps, prompt: string, label: string): Promise<string> {
    const media = runMedia(deps.run);
    if (media == null) return "(no video or screenshot available to scan)";
    // The agent PAUSES TO REASON between actions, so the recording sits on one static view for long
    // stretches - a vision model that samples sparsely can mistake that for "nothing happened". Tell it the
    // pacing is by design and to scan the WHOLE timeline, not just the opening screen.
    const scanPrompt = media.type === "file" ? `${VIDEO_SCAN_GUIDANCE}\n\n${prompt}` : prompt;
    try {
        const { text } = await withRetry(
            () =>
                generateText({
                    model: deps.visionModel,
                    messages: [{ role: "user", content: [{ type: "text", text: scanPrompt }, media] }],
                    abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
                }),
            { label },
        );
        return text.trim();
    } catch (error) {
        return `(${label} failed: ${error instanceof Error ? error.message : String(error)})`;
    }
}

/** Build the investigation prompt: the static context + the run trace + the probes, then investigate. */
function buildInvestigationPrompt(
    context: ClassifyContext,
    run: ClassifierDeps["run"],
    errorScan: string,
    fidelityScan: string,
    visualScan: string,
    toolNote: string | undefined,
): string {
    return [
        "Classify this test run.",
        ...(toolNote != null ? [`\n--- BACKEND INTROSPECTION UNAVAILABLE ---\n${toolNote}`] : []),
        `App: ${context.appSlug}  PR #${context.prNumber}  Test: ${context.test.slug}`,
        "\nPR INTENT (the author's stated goal - a behavior change the PR set out to make is NOT a bug):",
        `  title: ${context.prTitle != null && context.prTitle !== "" ? context.prTitle : "(unavailable)"}`,
        `  description: ${context.prBody != null && context.prBody !== "" ? context.prBody.slice(0, PR_BODY_LIMIT) : "(none)"}`,
        `\nTest instruction:\n${context.test.plan}`,
        `\nWhy this test was selected for the diff:\n${context.test.affectedReason}`,
        `\nDiff stat:\n${context.diffSummary}`,
        `\nScenario provisioning for this run: status=${context.provision.status} - ${context.provision.detail}`,
        `Data this scenario seeded into the env: ${context.provision.seeded ?? "(the up did not report seeded refs here - do NOT read this as 'nothing was seeded'; if auth+data were returned above, provisioning worked)"}`,
        "Treat the provisioning line above as FACT about what the up actually did. If valid auth WAS returned and entities WERE seeded, the setup is healthy: a stuck-at-login or empty screen is then NOT scenario_issue - look downstream (the login step, an engine/agent stall, a flaky never-passed test). Only call scenario_issue when the up genuinely returned no auth or the needed records are actually absent.",
        "\n--- THE RUNNER'S OWN CLAIM (a HINT, not the truth) ---",
        `success: ${run.success}  finishReason: ${run.finishReason}  stepsTaken: ${run.stepCount}`,
        `agent final reasoning: ${run.reasoning ?? "(none)"}`,
        `\nStep-by-step trace (interaction · status · engine error per step):\n${run.steps.length > 0 ? run.steps.join("\n") : "(no steps recorded)"}`,
        "Two different things live here, do NOT conflate them. (a) The runner's self-reported OUTCOME (success/finishReason/reasoning) is a HINT only - it optimizes to COMPLETE the test, not audit the app, so it reports success on a visibly-broken app and gives tidy failure reasons that miss the real problem. (b) The step-by-step trace is CONCRETE EVIDENCE of what the agent actually DID: each line is an interaction the agent attempted, its per-step status, and a real screenshot captured at that step (view_step_screenshot). A step that succeeded means that action genuinely happened on screen.",
        "RECONCILE the vision scans against the step trace - they must agree on what physically occurred. If a scan says the agent 'never did X' / 'stayed on the login/one screen' / 'no interactions', but the trace shows SUCCESSFUL type/click steps, the SCAN is wrong, not the trace: this is almost always a long video the vision model sampled too sparsely, so it only 'saw' the opening screen. NEVER conclude 'stayed on login' or 'no auth applied' when the trace shows successful typed/clicked login steps - instead view_step_screenshot on the LATER steps to see the true end state, and trust those frames. The video and the per-step screenshots are BOTH ground truth; when they conflict, the concrete per-step screenshots win.",
        "\n--- AUTOMATED ERROR SCAN (independent vision pass over the full video) ---",
        errorScan,
        "If this scan lists ANY error states, they were ON SCREEN during the run - treat them as observed FACT to verify and account for; do NOT conclude the app behaved correctly. Errors across MULTIPLE interactions are a pattern and almost certainly the primary defect.",
        "\n--- AUTOMATED FIDELITY SCAN (did the run follow the written steps?) ---",
        fidelityScan,
        "If the run DIVERGED from the plan, it never actually exercised the intended behaviour - the 'failure' is then most likely the test/plan not matching the UI (outdated_test / bad_test), NOT an app defect. A client_bug verdict REQUIRES that the run faithfully reached and exercised the behaviour under test. Set planFidelity from this scan.",
        "\n--- AUTOMATED VISUAL-SANITY SCAN (does the app look broken, independent of the test?) ---",
        visualScan,
        "These are a vision model's HINTS about app problems a human would spot at a glance - regardless of what the test was doing. They are NOT confirmed: for each one, VERIFY it yourself (analyze_video to localize it, view_step_screenshot for the exact frame, and look at the attached final screenshot) and decide if it is real - YOU have the final say and may dismiss a false flag. Every visual problem you CONFIRM goes in `observedAppIssues`, ALWAYS, even when your main verdict is about something else (e.g. a bad test): a broken app surfaced by a test that was also broken is still a broken app and must be reported.",
        run.finalScreenshot != null
            ? "\nThe FINAL screen the agent saw is attached below as an image - look at it DIRECTLY."
            : "",
        "\nStart with prior_runs to establish the baseline. Use analyze_video to CONFIRM and localize anything the scans flagged, view_step_screenshot for the exact frame at a step, and run_script to verify backend data. Then I will ask for your verdict.",
    ].join("\n");
}

/**
 * Classify the outcome of a browser test run: investigate the cause with the tools, then commit to a
 * single verdict. The 300-line monolith is gone - the prompt, tools, schema, and retry each live in their
 * own module, and every capability is injected (ClassifierDeps) so this is unit-testable with fakes.
 */
export async function classifyRun(context: ClassifyContext, deps: ClassifierDeps): Promise<RunVerdict> {
    const logger = rootLogger.child({
        name: "classifyRun",
        extra: { appSlug: context.appSlug, prNumber: context.prNumber, test: context.test.slug },
    });
    logger.info("Classifying run outcome", {
        extra: { success: deps.run.success, finishReason: deps.run.finishReason },
    });

    // Deterministic probes FIRST - surface on-screen errors + plan divergence as fact before the classifier
    // reasons, so neither signal can be missed in favour of a diff-based hypothesis.
    const [errorScan, fidelityScan, visualScan] = await Promise.all([
        visionProbe(deps, ERROR_PROBE_PROMPT, "error-probe"),
        visionProbe(deps, `${FIDELITY_PROBE_PROMPT}\n\nINTENDED STEPS:\n${context.test.plan}`, "fidelity-probe"),
        visionProbe(deps, VISUAL_SANITY_PROBE_PROMPT, "visual-sanity-probe"),
    ]);
    logger.info("Probes complete", {
        extra: {
            foundErrors: !errorScan.startsWith("NO VISIBLE ERRORS"),
            fidelity: fidelityScan.split("FIDELITY:").pop()?.trim().slice(0, 20),
            visualIssues: !visualScan.startsWith("NOTHING OBVIOUSLY WRONG"),
        },
    });

    const tools = buildClassifierTools(deps);
    const toolNote = describeUnavailableTools(deps);
    const userContent: Array<{ type: "text"; text: string } | { type: "image"; image: Uint8Array }> = [
        {
            type: "text",
            text: buildInvestigationPrompt(context, deps.run, errorScan, fidelityScan, visualScan, toolNote),
        },
    ];
    if (deps.run.finalScreenshot != null) {
        userContent.push({ type: "image", image: deps.run.finalScreenshot });
    }

    const investigation = await withRetry(
        () =>
            generateText({
                model: deps.reasoningModel,
                system: CLASSIFIER_SYSTEM_PROMPT,
                tools,
                stopWhen: stepCountIs(deps.maxSteps),
                messages: [{ role: "user", content: userContent }],
                // Abort a hung provider connection (no response, no error) so withRetry can re-issue it.
                abortSignal: AbortSignal.timeout(INVESTIGATION_TIMEOUT_MS),
            }),
        { label: "investigation" },
    );

    const verdictGeneration = await withRetry(
        () =>
            generateText({
                model: deps.reasoningModel,
                system: CLASSIFIER_SYSTEM_PROMPT,
                output: Output.object({ schema: VerdictForModel }),
                prompt: buildVerdictPrompt(context.test.plan, investigation.text),
                abortSignal: AbortSignal.timeout(VERDICT_TIMEOUT_MS),
            }),
        { label: "verdict" },
    );

    const verdict = toRunVerdict(verdictGeneration.output);
    logger.info("Run classified", { extra: { category: verdict.category, confidence: verdict.confidence } });
    return verdict;
}
