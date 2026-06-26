import { type LanguageModel, type Tool, generateText, tool } from "ai";
import { z } from "zod";
import type { ClassifierDeps, CodebaseReader, PreviewAccess, RunArtifacts } from "./dependencies";

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The baseline tool: has this test ever passed? Call FIRST to set the prior. */
export function createPriorRunsTool(loadBaseline: () => Promise<string>): Tool {
    return tool({
        description:
            "The prior run history for THIS test (most recent first, across branches): has it EVER passed, when last, and the recent pass/fail pattern. CALL THIS FIRST - it sets your baseline. A prior pass proves the test+scenario were valid then; never having passed means the test/scenario may be broken from genesis - do not blame the PR.",
        inputSchema: z.object({}),
        execute: async () => {
            try {
                return await loadBaseline();
            } catch (error) {
                return `Could not read prior runs: ${errorMessage(error)}`;
            }
        },
    });
}

/** The run-script harness: confirm whether the data the test needs actually exists in the live backend. */
export function createRunScriptTool(preview: PreviewAccess): Tool {
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
                return await preview.runScript({ script, packages });
            } catch (error) {
                return `Script harness error: ${errorMessage(error)}`;
            }
        },
    });
}

/** Which env vars the preview has configured (presence diagnoses a missing key/flag/integration). */
export function createPreviewEnvTool(preview: PreviewAccess): Tool {
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
                return `Env vars configured in the preview${filter != null ? ` matching "${filter}"` : ""} (values masked):\n${names.map((name) => `- ${name}`).join("\n")}`;
            } catch (error) {
                return `Could not read preview env: ${errorMessage(error)}`;
            }
        },
    });
}

/** App logs over the run window, filtered by a regex. */
export function createAppLogsTool(loadAppLogs: (regex: string) => Promise<string>): Tool {
    return tool({
        description:
            "The app's logs over the exact run window, filtered by a regex. An error here is a candidate, not a conclusion - confirm it blocked the failing step.",
        inputSchema: z.object({
            regex: z.string().default("(?i)error|exception|econnrefused|etimedout|unauthorized|fatal|uncaught"),
        }),
        execute: async ({ regex }) => {
            try {
                return await loadAppLogs(regex);
            } catch (error) {
                return `Could not read app logs: ${errorMessage(error)}`;
            }
        },
    });
}

/** Preview k8s deployment/pod health (a down service behind a 'no data' symptom). */
export function createDeploymentHealthTool(loadDeploymentHealth: () => Promise<string>): Tool {
    return tool({
        description:
            "The preview env's k8s deployments and pods (READY counts show which services are scaled up). Use to spot a down dependency (scaled to 0/0 or crash-looping) behind a 'no data' symptom.",
        inputSchema: z.object({}),
        execute: async () => {
            try {
                return await loadDeploymentHealth();
            } catch (error) {
                return `Could not read deployment health: ${errorMessage(error)}`;
            }
        },
    });
}

/** Read a file (line range) from the cloned repo at the PR head. */
export function createReadCodeTool(codebase: CodebaseReader): Tool {
    return tool({
        description:
            "Read a file (lines) from the cloned repo at the PR head. Also opens the project's generated `autonoma/` artifacts (AUTONOMA.md, scenarios.md, recipe.json) and the seeding handler.",
        inputSchema: z.object({ file: z.string(), fromLine: z.number().default(1), toLine: z.number().default(160) }),
        execute: async ({ file, fromLine, toLine }) => {
            try {
                return (await codebase.readFile(file, fromLine, toLine)) || "(empty)";
            } catch (error) {
                return `could not read ${file}: ${errorMessage(error)}`;
            }
        },
    });
}

/** Grep the cloned repo for a pattern. */
export function createGrepCodeTool(codebase: CodebaseReader): Tool {
    return tool({
        description: "grep the cloned repo for a string/pattern to find a handler, a dependency, a route, or a label.",
        inputSchema: z.object({ pattern: z.string() }),
        execute: async ({ pattern }) => {
            try {
                return (await codebase.grep(pattern)) || "(no matches)";
            } catch (error) {
                return `could not grep: ${errorMessage(error)}`;
            }
        },
    });
}

/** The PR's patch (base..head), optionally for one file - intent source + attribution. */
export function createGitDiffTool(codebase: CodebaseReader): Tool {
    return tool({
        description:
            "The PR's actual patch (base..head), optionally for one file path, to check whether the failing feature's files were really changed.",
        inputSchema: z.object({ path: z.string().optional() }),
        execute: async ({ path }) => {
            try {
                return (await codebase.diff(path)) || "(no changes)";
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
export function createAnalyzeVideoTool(run: RunArtifacts, visionModel: LanguageModel): Tool {
    return tool({
        description:
            "Watch the run's full screen recording and answer a SPECIFIC question about it. Survey the WHOLE run, not just the blocking step: where the agent progressed AND every error state on screen (error toasts/banners, red text, 5xx, broken/blank renders, wrong responses) with the exact moment + verbatim text. Ask pointed questions (e.g. 'list every error message shown and after which action') rather than 'what happened'. Use this almost always.",
        inputSchema: z.object({ question: z.string() }),
        execute: async ({ question }) => {
            if (run.video == null) return "No video recorded for this run.";
            try {
                return await describeMedia(
                    visionModel,
                    `${question}\n\nThis is the full screen recording of the run, start to finish.`,
                    {
                        type: "file",
                        data: run.video,
                        mediaType: "video/webm",
                    },
                );
            } catch (error) {
                return `Could not analyze the video: ${errorMessage(error)}`;
            }
        },
    });
}

/** Ask a vision model about the final screen the agent saw. */
export function createAnalyzeScreenshotTool(run: RunArtifacts, visionModel: LanguageModel): Tool {
    return tool({
        description: "Ask a vision model a specific question about the final screen the agent saw.",
        inputSchema: z.object({ question: z.string() }),
        execute: async ({ question }) => {
            if (run.finalScreenshot == null) return "No final screenshot available.";
            try {
                return await describeMedia(visionModel, question, { type: "image", image: run.finalScreenshot });
            } catch (error) {
                return `Could not analyze the screenshot: ${errorMessage(error)}`;
            }
        },
    });
}

/** Ask a vision model about the screenshot captured after a specific step (a timing-race check). */
export function createViewStepScreenshotTool(run: RunArtifacts, visionModel: LanguageModel): Tool {
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
                return await describeMedia(
                    visionModel,
                    `This is the screenshot AFTER step ${step} of ${run.stepScreenshots.length}. ${question}`,
                    {
                        type: "image",
                        image,
                    },
                );
            } catch (error) {
                return `Could not analyze step ${step}: ${errorMessage(error)}`;
            }
        },
    });
}

/** Assemble the full classifier tool set from the injected capabilities. */
export function buildClassifierTools(deps: ClassifierDeps): Record<string, Tool> {
    return {
        prior_runs: createPriorRunsTool(deps.loadBaseline),
        run_script: createRunScriptTool(deps.preview),
        get_preview_env: createPreviewEnvTool(deps.preview),
        get_app_logs: createAppLogsTool(deps.loadAppLogs),
        get_deployment_health: createDeploymentHealthTool(deps.loadDeploymentHealth),
        read_code: createReadCodeTool(deps.codebase),
        grep_code: createGrepCodeTool(deps.codebase),
        git_diff: createGitDiffTool(deps.codebase),
        analyze_video: createAnalyzeVideoTool(deps.run, deps.visionModel),
        analyze_screenshot: createAnalyzeScreenshotTool(deps.run, deps.visionModel),
        view_step_screenshot: createViewStepScreenshotTool(deps.run, deps.visionModel),
    };
}
