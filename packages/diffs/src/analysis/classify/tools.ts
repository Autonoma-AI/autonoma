import { type LanguageModel, type Tool, generateText, tool } from "ai";
import { z } from "zod";
import { type ToolCap, createToolBudget } from "../tool-output";
import type { ClassifierDeps, CodebaseReader, PreviewAccess, RunArtifacts } from "./dependencies";

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Per-tool result ceilings. A single result may use up to this many chars AND whatever cumulative run budget
 * remains (see createToolBudget) - so a big source file reads in full early in a run while the run's total tool
 * output stays bounded.
 */
const READ_CODE_MAX_CHARS = 150_000; // a ~3,000-line source file, read whole
const GIT_DIFF_MAX_CHARS = 150_000; // a large patch (the reader already drops lockfile/build noise)
const GREP_MAX_CHARS = 24_000; // ripgrep is already capped at 80 matches
const RUN_SCRIPT_MAX_CHARS = 24_000;
const APP_LOGS_MAX_CHARS = 24_000;
const PRIOR_RUNS_MAX_CHARS = 24_000;
const COMPACT_MAX_CHARS = 16_000; // env/health lists, vision answers

/** The baseline tool: has this test ever passed? Call FIRST to set the prior. */
export function createPriorRunsTool(loadBaseline: () => Promise<string>, cap: ToolCap): Tool {
    return tool({
        description:
            "The prior run history for THIS test (most recent first, across branches): has it EVER passed, when last, and the recent pass/fail pattern. CALL THIS FIRST - it sets your baseline. A prior pass proves the test+scenario were valid then; never having passed means the test/scenario may be broken from genesis - do not blame the PR.",
        inputSchema: z.object({}),
        execute: async () => {
            try {
                return cap(await loadBaseline(), {
                    tool: "prior_runs",
                    mode: "truncate",
                    maxChars: PRIOR_RUNS_MAX_CHARS,
                });
            } catch (error) {
                return `Could not read prior runs: ${errorMessage(error)}`;
            }
        },
    });
}

/** The run-script harness: confirm whether the data the test needs actually exists in the live backend. */
export function createRunScriptTool(preview: PreviewAccess, cap: ToolCap): Tool {
    return tool({
        description:
            "Write and run a throwaway Node.js (ESM) script against the LIVE preview backend, with the preview's OWN environment variables injected. Use it to CONFIRM whether the data the test needs actually exists - install the client's DB/backend SDK ('pg', 'firebase-admin', ...) and query for the specific record. Read-only: query and print with console.log, never mutate. This turns 'the row wasn't on screen' into a fact: absent in the backend -> scenario/recipe gap; present but not shown -> a real app problem.",
        inputSchema: z.object({
            script: z
                .string()
                .describe("ESM Node script body. Print findings with console.log. Top-level await is allowed."),
            packages: z
                .array(z.string())
                .optional()
                .describe("npm packages to install first, e.g. ['pg'] or ['firebase-admin']"),
        }),
        execute: async ({ script, packages }) => {
            try {
                // truncate (not narrow): a script can run non-idempotent ops (e.g. scenario `up`); never ask to re-run it.
                return cap(await preview.runScript({ script, packages }), {
                    tool: "run_script",
                    mode: "truncate",
                    maxChars: RUN_SCRIPT_MAX_CHARS,
                });
            } catch (error) {
                return `Script harness error: ${errorMessage(error)}`;
            }
        },
    });
}

/** Which env vars the preview has configured (presence diagnoses a missing key/flag/integration). */
export function createPreviewEnvTool(preview: PreviewAccess, cap: ToolCap): Tool {
    return tool({
        description:
            "List the environment-variable NAMES configured in THIS PR's preview deployment (values masked). Decisive for config/flag gaps: if a third-party SDK / integration key is ABSENT, that SDK never initializes, so anything it gates falls back to its code default - often OFF. Check here before blaming the scenario for a config/flag-gated redirect or a missing integration.",
        inputSchema: z.object({
            filter: z
                .string()
                .optional()
                .describe("optional case-insensitive substring to filter var names, e.g. a provider name or 'KEY'"),
        }),
        execute: async ({ filter }) => {
            try {
                const names = await preview.getEnvVarNames(filter);
                if (names.length === 0) {
                    return `No env vars${filter != null ? ` matching "${filter}"` : ""} are configured in this preview. (Absence means that integration is unconfigured here, so anything it gates falls back to code defaults.)`;
                }
                return cap(
                    `Env vars configured in the preview${filter != null ? ` matching "${filter}"` : ""} (values masked):\n${names.map((name) => `- ${name}`).join("\n")}`,
                    { tool: "get_preview_env", mode: "truncate", maxChars: COMPACT_MAX_CHARS },
                );
            } catch (error) {
                return `Could not read preview env: ${errorMessage(error)}`;
            }
        },
    });
}

/** App logs over the run window, filtered by a regex. */
export function createAppLogsTool(loadAppLogs: (regex: string) => Promise<string>, cap: ToolCap): Tool {
    return tool({
        description:
            "The app's logs over the exact run window, filtered by a regex. An error here is a candidate, not a conclusion - confirm it blocked the failing step.",
        inputSchema: z.object({
            regex: z.string().default("(?i)error|exception|econnrefused|etimedout|unauthorized|fatal|uncaught"),
        }),
        execute: async ({ regex }) => {
            try {
                return cap(await loadAppLogs(regex), {
                    tool: "get_app_logs",
                    mode: "narrow",
                    maxChars: APP_LOGS_MAX_CHARS,
                    hint: "a tighter regex.",
                });
            } catch (error) {
                return `Could not read app logs: ${errorMessage(error)}`;
            }
        },
    });
}

/** Preview k8s deployment/pod health (a down service behind a 'no data' symptom). */
export function createDeploymentHealthTool(loadDeploymentHealth: () => Promise<string>, cap: ToolCap): Tool {
    return tool({
        description:
            "The preview env's k8s deployments and pods (READY counts show which services are scaled up). Use to spot a down dependency (scaled to 0/0 or crash-looping) behind a 'no data' symptom.",
        inputSchema: z.object({}),
        execute: async () => {
            try {
                return cap(await loadDeploymentHealth(), {
                    tool: "get_deployment_health",
                    mode: "truncate",
                    maxChars: COMPACT_MAX_CHARS,
                });
            } catch (error) {
                return `Could not read deployment health: ${errorMessage(error)}`;
            }
        },
    });
}

/** Read a file (line range) from the cloned repo at the PR head. */
export function createReadCodeTool(codebase: CodebaseReader, cap: ToolCap): Tool {
    return tool({
        description:
            "Read a file (lines) from the cloned repo at the PR head. Also opens the project's generated `autonoma/` artifacts (AUTONOMA.md, scenarios.md, recipe.json) and the seeding handler.",
        inputSchema: z.object({ file: z.string(), fromLine: z.number().default(1), toLine: z.number().default(160) }),
        execute: async ({ file, fromLine, toLine }) => {
            try {
                const content = (await codebase.readFile(file, fromLine, toLine)) || "(empty)";
                return cap(content, {
                    tool: "read_code",
                    mode: "narrow",
                    maxChars: READ_CODE_MAX_CHARS,
                    hint: "a smaller fromLine/toLine window, or a more specific file.",
                });
            } catch (error) {
                return `could not read ${file}: ${errorMessage(error)}`;
            }
        },
    });
}

/** Grep the cloned repo for a pattern. */
export function createGrepCodeTool(codebase: CodebaseReader, cap: ToolCap): Tool {
    return tool({
        description: "grep the cloned repo for a string/pattern to find a handler, a dependency, a route, or a label.",
        inputSchema: z.object({ pattern: z.string() }),
        execute: async ({ pattern }) => {
            try {
                return cap((await codebase.grep(pattern)) || "(no matches)", {
                    tool: "grep_code",
                    mode: "narrow",
                    maxChars: GREP_MAX_CHARS,
                    hint: "a more specific pattern, or grep within a known path.",
                });
            } catch (error) {
                return `could not grep: ${errorMessage(error)}`;
            }
        },
    });
}

/** The PR's patch (base..head), optionally for one file - intent source + attribution. */
export function createGitDiffTool(codebase: CodebaseReader, cap: ToolCap): Tool {
    return tool({
        description:
            "The PR's actual patch (base..head), optionally for one file path, to check whether the failing feature's files were really changed.",
        inputSchema: z.object({ path: z.string().optional() }),
        execute: async ({ path }) => {
            try {
                return cap((await codebase.diff(path)) || "(no changes)", {
                    tool: "git_diff",
                    mode: "narrow",
                    maxChars: GIT_DIFF_MAX_CHARS,
                    hint: "pass a specific file path.",
                });
            } catch (error) {
                return `could not diff: ${errorMessage(error)}`;
            }
        },
    });
}

async function describeMedia(
    visionModel: LanguageModel,
    prompt: string,
    media: { type: "image"; image: Uint8Array } | { type: "file"; data: Uint8Array; mediaType: string },
): Promise<string> {
    const { text } = await generateText({
        model: visionModel,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }, media] }],
    });
    return text;
}

/** Ask a vision model a specific question about the full run video (survey the whole run, including errors). */
export function createAnalyzeVideoTool(run: RunArtifacts, visionModel: LanguageModel, cap: ToolCap): Tool {
    return tool({
        description:
            "Watch the run's full screen recording and answer a SPECIFIC question about it. Survey the WHOLE run, not just the blocking step: where the agent progressed AND every error state on screen (error toasts/banners, red text, 5xx, broken/blank renders, wrong responses) with the exact moment + verbatim text. Ask pointed questions (e.g. 'list every error message shown and after which action') rather than 'what happened'. Use this almost always.",
        inputSchema: z.object({ question: z.string() }),
        execute: async ({ question }) => {
            if (run.video == null) return "No video recorded for this run.";
            try {
                const answer = await describeMedia(
                    visionModel,
                    `${question}\n\nThis is the full screen recording of the run, start to finish.`,
                    { type: "file", data: run.video.data, mediaType: run.video.mediaType },
                );
                // truncate (not narrow): re-running a vision call is expensive; keep head+tail rather than ask again.
                return cap(answer, { tool: "analyze_video", mode: "truncate", maxChars: COMPACT_MAX_CHARS });
            } catch (error) {
                return `Could not analyze the video: ${errorMessage(error)}`;
            }
        },
    });
}

/** Ask a vision model about the final screen the agent saw. */
export function createAnalyzeScreenshotTool(run: RunArtifacts, visionModel: LanguageModel, cap: ToolCap): Tool {
    return tool({
        description: "Ask a vision model a specific question about the final screen the agent saw.",
        inputSchema: z.object({ question: z.string() }),
        execute: async ({ question }) => {
            if (run.finalScreenshot == null) return "No final screenshot available.";
            try {
                const answer = await describeMedia(visionModel, question, {
                    type: "image",
                    image: run.finalScreenshot,
                });
                return cap(answer, { tool: "analyze_screenshot", mode: "truncate", maxChars: COMPACT_MAX_CHARS });
            } catch (error) {
                return `Could not analyze the screenshot: ${errorMessage(error)}`;
            }
        },
    });
}

/** Ask a vision model about the screenshot captured after a specific step (a timing-race check). */
export function createViewStepScreenshotTool(run: RunArtifacts, visionModel: LanguageModel, cap: ToolCap): Tool {
    return tool({
        description:
            "View the screenshot captured AFTER a specific completed step (1-indexed) to check the exact visual state - e.g. whether an asserted control had settled or was still mid-transition (a timing race).",
        inputSchema: z.object({ step: z.number().describe("1-indexed step number"), question: z.string() }),
        execute: async ({ step, question }) => {
            if (run.stepScreenshots.length === 0) return "No per-step screenshots were captured for this run.";
            const image = run.stepScreenshots[step - 1];
            if (image == null)
                return `No screenshot for step ${step} - this run has ${run.stepScreenshots.length} steps.`;
            try {
                const answer = await describeMedia(
                    visionModel,
                    `This is the screenshot AFTER step ${step} of ${run.stepScreenshots.length}. ${question}`,
                    { type: "image", image },
                );
                return cap(answer, { tool: "view_step_screenshot", mode: "truncate", maxChars: COMPACT_MAX_CHARS });
            } catch (error) {
                return `Could not analyze step ${step}: ${errorMessage(error)}`;
            }
        },
    });
}

/**
 * Assemble the classifier tool set from the injected capabilities, sharing one per-run output budget. The
 * preview-backend tools (run_script, get_preview_env) and get_app_logs are included ONLY when the preview is
 * integrated with our previewkit (deps.preview / deps.loadAppLogs present) - a non-integrated preview has no
 * backend harness or log stream, so offering those tools only wastes steps and produces confusing failures
 * (a credential error, an "unavailable" note) that the model can mistake for signal. describeUnavailableTools
 * tells the model, in the run prompt, which introspection it is missing and why.
 */
export function buildClassifierTools(deps: ClassifierDeps): Record<string, Tool> {
    const cap = createToolBudget();
    const tools: Record<string, Tool> = {
        prior_runs: createPriorRunsTool(deps.loadBaseline, cap),
        get_deployment_health: createDeploymentHealthTool(deps.loadDeploymentHealth, cap),
        read_code: createReadCodeTool(deps.codebase, cap),
        grep_code: createGrepCodeTool(deps.codebase, cap),
        git_diff: createGitDiffTool(deps.codebase, cap),
        analyze_video: createAnalyzeVideoTool(deps.run, deps.visionModel, cap),
        analyze_screenshot: createAnalyzeScreenshotTool(deps.run, deps.visionModel, cap),
        view_step_screenshot: createViewStepScreenshotTool(deps.run, deps.visionModel, cap),
    };
    if (deps.preview != null) {
        tools.run_script = createRunScriptTool(deps.preview, cap);
        tools.get_preview_env = createPreviewEnvTool(deps.preview, cap);
    }
    if (deps.loadAppLogs != null) {
        tools.get_app_logs = createAppLogsTool(deps.loadAppLogs, cap);
    }
    return tools;
}

/**
 * A run-prompt note naming the backend introspection the model does NOT have for this run, or undefined when
 * everything is available. The framing branches on WHICH capability is missing - it must never tell the model
 * "there is no backend harness" while run_script is in its toolset - so a missing tool is never read as a
 * workaround target, as evidence, or (in the integrated-but-no-logs case) as a reason to stop introspecting.
 */
export function describeUnavailableTools(deps: ClassifierDeps): string | undefined {
    const backendMissing = deps.preview == null;
    const logsMissing = deps.loadAppLogs == null;
    if (!backendMissing && !logsMissing) return undefined;

    // Nothing to introspect: the preview is not previewkit-managed, so neither logs nor the backend are reachable.
    if (backendMissing && logsMissing) {
        return [
            "NOT AVAILABLE for this run: run_script (query the live backend), get_preview_env (read the preview's",
            "configured env), get_app_logs (read the app's server logs). This PR's preview is not managed by our",
            "previewkit, so there is no server-side log stream or backend script harness to reach. Do NOT treat their",
            "absence as evidence and do NOT try to work around it. Because you cannot read the logs or query the",
            "backend, you canNOT confirm an UNSEEN mechanism (a failed or rejected write, a 5xx, a thrown exception):",
            "a persistence/data-integrity or unseen-backend symptom is UNPROVABLE here - do not raise it above LOW",
            "confidence, prefer environment_failure / scenario_issue / a labelled hypothesis over a client_bug you",
            "cannot verify. Classify by what you DIRECTLY observed and say plainly what you could not check.",
        ].join(" ");
    }
    // Integrated preview, but the app-log stream is not configured on this worker. The backend harness DOES work,
    // so point the model at run_script rather than telling it introspection is impossible.
    if (logsMissing) {
        return [
            "NOT AVAILABLE for this run: get_app_logs (read the app's server logs) - the log stream is not configured",
            "for this worker. The preview IS previewkit-managed, so run_script (query the live backend) and",
            "get_preview_env (read the preview's configured env) DO work: USE run_script to confirm backend state",
            "(whether a write landed, whether a record exists) in place of the logs. Any claim that rests",
            "specifically on a log line you could not read stays at LOW confidence until run_script corroborates it.",
        ].join(" ");
    }
    // Backend harness absent but logs present (does not arise from the worker's gating, but keep the note honest).
    return [
        "NOT AVAILABLE for this run: run_script (query the live backend), get_preview_env (read the preview's",
        "configured env). get_app_logs (read the app's server logs) IS available - use it to confirm what actually",
        "happened; any claim that needs a live backend query you could not run stays at LOW confidence.",
    ].join(" ");
}
