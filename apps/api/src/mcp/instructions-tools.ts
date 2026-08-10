import { BadRequestError } from "@autonoma/errors";
import { APPLICATION_INSTRUCTIONS_MAX_LENGTH } from "@autonoma/types";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Services } from "../routes/build-services";
import type { McpAnalytics } from "./mcp-analytics";
import { targetInputFields, toTargetInput } from "./mcp-target-input";
import type { McpTarget, McpTargetInput } from "./resolve-mcp-target";
import { jsonResult, toToolResult } from "./tool-result";
import type { WriteGuard } from "./write-guard";

export interface InstructionsToolDeps {
    services: Services;
    analytics: McpAnalytics;
    resolveTarget: (input: McpTargetInput) => Promise<McpTarget>;
    guard: WriteGuard;
}

/** Which of the two fields a write touched - what the activity row says when the agent wrote no line. */
function describeWrite(wroteInstructions: boolean, wroteGuidelines: boolean): string {
    if (wroteInstructions && wroteGuidelines) return "Updating the agent instructions and test scope guidelines";
    return wroteInstructions ? "Updating the agent instructions" : "Updating the test scope guidelines";
}

/**
 * Read and write the application's standing instructions - the free text a user maintains on the
 * settings page, which is fed to Autonoma's agents on every run.
 *
 * These exist so knowledge an agent earns while debugging can outlive the session it was earned
 * in. An agent that has just established that a flagged issue was a false positive, or that a
 * screen behaves in a way no test plan would guess, currently has nowhere to put that: it explains
 * it in chat, the session ends, and Autonoma rediscovers the same wrong thing next week.
 *
 * The two fields are NOT interchangeable - they are read by different agents at different moments
 * (see each tool's description), so writing to the wrong one is the same as not writing at all.
 */
export function registerInstructionsTools(
    server: McpServer,
    { services, analytics, resolveTarget, guard }: InstructionsToolDeps,
) {
    server.registerTool(
        "get_app_instructions",
        {
            title: "Read the app's standing instructions",
            description:
                "Read the two standing instruction fields a user maintains on this application's settings page. " +
                "Both are prose, both are fed to Autonoma's agents on every run, and they are read by DIFFERENT " +
                "agents: `customInstructions` reaches the agent that DRIVES each test (how this app behaves - a " +
                "cookie banner to dismiss, a credential to use, a spinner to wait out), while " +
                "`testScopeGuidelines` reaches the agent that DECIDES WHAT TO TEST and how to judge it (what is " +
                "out of scope, what is business-critical, and what Autonoma keeps flagging that is not actually a " +
                "bug). Read this before writing: it returns a `fingerprint` that update_app_instructions needs, " +
                "and you cannot merge your addition into a user's wording without first seeing it.",
            inputSchema: targetInputFields,
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        async (input) =>
            analytics.track("get_app_instructions", async () => {
                try {
                    const { applicationId, organizationId } = await resolveTarget(toTargetInput(input));
                    return jsonResult(await services.applications.getInstructions(applicationId, organizationId));
                } catch (err) {
                    return toToolResult(err);
                }
            }),
    );

    server.registerTool(
        "update_app_instructions",
        {
            title: "Update the app's standing instructions",
            description:
                "Record something you learned about this application so Autonoma's agents carry it into every " +
                "future run. Use it for knowledge that will still be true next month - a false positive worth " +
                "suppressing, an area that should not be tested, a quirk of the app that misleads the agent - not " +
                "for a note about the pull request in front of you.\n\n" +
                "Pick the field by WHICH agent needs to know:\n" +
                "- `testScopeGuidelines` - what to test and how to judge it. This is where a FALSE POSITIVE " +
                "belongs: say what was flagged and why it is intended behavior, so the analysis stops raising it.\n" +
                "- `customInstructions` - how to drive the app during a run. Steps, credentials, and UI quirks the " +
                "agent has to know to get through a flow.\n\n" +
                "Each field is a FULL REPLACEMENT of that field, and the text is a human's - you are editing the " +
                "user's settings page, not appending to a log. So: call get_app_instructions first, keep what is " +
                "already there, add your point to it, and send the merged text with that read's `fingerprint` as " +
                "`baseFingerprint`. Omit a field entirely to leave it untouched. Write plainly and specifically, " +
                "the way the user would - this text is read by an agent later with none of your current context.",
            inputSchema: {
                ...targetInputFields,
                customInstructions: z
                    .string()
                    .max(APPLICATION_INSTRUCTIONS_MAX_LENGTH)
                    .nullable()
                    .optional()
                    .describe(
                        "The complete new text for the run-time agent instructions, including what was already " +
                            "there. Omit to leave this field alone; send null to clear it.",
                    ),
                testScopeGuidelines: z
                    .string()
                    .max(APPLICATION_INSTRUCTIONS_MAX_LENGTH)
                    .nullable()
                    .optional()
                    .describe(
                        "The complete new text for the test-scope guidelines, including what was already there. " +
                            "Omit to leave this field alone; send null to clear it.",
                    ),
                baseFingerprint: z
                    .string()
                    .optional()
                    .describe(
                        "The `fingerprint` from get_app_instructions. Always pass it: if the user edited their " +
                            "settings in between, the write is rejected and you get their text back instead of " +
                            "overwriting words there is no history to restore. Omitting it makes your write " +
                            "unconditional.",
                    ),
                description: z
                    .string()
                    .min(1)
                    .optional()
                    .describe("One line on what you recorded - the user watches it on the activity feed."),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        async ({ customInstructions, testScopeGuidelines, baseFingerprint, description, ...target }) =>
            analytics.track("update_app_instructions", async () => {
                try {
                    const wroteInstructions = customInstructions !== undefined;
                    const wroteGuidelines = testScopeGuidelines !== undefined;
                    if (!wroteInstructions && !wroteGuidelines) {
                        throw new BadRequestError(
                            "Pass customInstructions or testScopeGuidelines (or both). A call with neither " +
                                "would write nothing - omitting a field is how you leave it untouched.",
                        );
                    }

                    const { applicationId, organizationId } = await resolveTarget(toTargetInput(target));
                    return guard(
                        {
                            applicationId,
                            organizationId,
                            tool: "update_app_instructions",
                            message: description ?? describeWrite(wroteInstructions, wroteGuidelines),
                            // Which fields moved, never the prose - the row is a summary line, and
                            // the full text is a page-long paragraph the user already has on screen.
                            toolArguments: {
                                customInstructions: wroteInstructions,
                                testScopeGuidelines: wroteGuidelines,
                            },
                        },
                        (org) =>
                            services.applications.updateInstructions({
                                applicationId,
                                organizationId: org,
                                customInstructions,
                                testScopeGuidelines,
                                baseFingerprint,
                            }),
                    );
                } catch (err) {
                    return toToolResult(err);
                }
            }),
    );
}
