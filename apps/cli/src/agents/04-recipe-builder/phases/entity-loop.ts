import { writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { tool } from "ai";
import type { LanguageModel } from "ai";
import spawn from "cross-spawn";
import { z } from "zod";
import { runAgent, buildDefaultStepLogger } from "../../../core/agent";
import { detectPackageManager, installCommand } from "../../../core/detect-pkg-manager";
import { formatException } from "../../../core/errors";
import { loadGitignorePatterns } from "../../../core/gitignore";
import { codeNoteFormat } from "../../../core/highlight";
import { notify } from "../../../core/notify";
import { toRecord } from "../../../core/to-record";
import { readEnv } from "../../../env";
import { buildReadFileTool, buildGlobTool, buildGrepTool } from "../../../tools";
import { buildAskUserTool } from "../../../tools/ask-user";
import {
    fetchDiscoverSchema,
    renderModelSchema,
    validateRecipeAgainstSchema,
    formatValidationProblems,
    type DiscoverSchema,
} from "../discover-schema";
import type { AuditedModel } from "../entity-order";
import * as sdk from "../http-client";
import type { SdkClientConfig } from "../http-client";
import { buildSingleEntityRecipe, type RecipePayload } from "../recipe";
import type { RecipeBuilderState, TechStack, EntityProgress } from "../state";
import { adapterLabel, saveRecipeState } from "../state";
import { classifyFailure, type FailurePhase } from "./failure-classifier";

const PROPOSAL_PROMPT = `You are a recipe data designer. Given an entity from the entity audit and the scenario data, produce a JSON array of records for this entity.

Rules:
- Use EXACT values from the scenarios.md file
- Add _alias fields (e.g., "entity_1", "entity_2") for referencing
- Use { "_ref": "alias" } syntax to reference previously-completed parent entities
- Match the field names and types from the entity audit's creation schema
- Include realistic, diverse data that covers different enum values
- For JSON/JSONB fields, use actual nested objects and arrays - NOT stringified JSON.
  WRONG: "metadata": "{\\"key\\": \\"value\\"}"
  RIGHT: "metadata": {"key": "value"}
- If you encounter untyped JSON/JSONB fields, use ask_user to ask the developer about the expected schema

When done, call finish with the JSON array.`;

const INSTRUCTIONS_PROMPT = `You are a pedagogical guide helping a developer implement an Autonoma SDK factory.

Given the entity audit information and the project's source code, produce clear, copy-pasteable instructions for implementing this factory. The developer will likely hand these to Claude or another AI assistant.

Include:
1. What to import (service classes, validators, Zod schemas)
2. The factory shape (inputSchema, create function, teardown function)
3. Where create() should call into (the project's existing service functions)
4. What teardown() should delete

Be specific - reference actual file paths, function names, and types from the codebase.

When done, call finish with the instructions text.`;

/**
 * Summarize the _alias values declared by already-completed entities, so a
 * revise/propose agent knows exactly which aliases it can target with _ref.
 * Without this the agent is blind to other entities and produces broken refs.
 */
function summarizeCompletedAliases(completedEntities: Record<string, EntityProgress>, excludeName?: string): string {
    return Object.entries(completedEntities)
        .filter(([name, e]) => name !== excludeName && e.recipeData && e.recipeData.length > 0)
        .map(([name, e]) => `${name}: aliases ${e.recipeData!.map((r) => r._alias ?? "?").join(", ")}`)
        .join("\n");
}

/** A one-line summary of how the audit says an entity is created, used to ground
 *  the failure classifier (e.g. so a "no factory registered" error is judgeable). */
function summarizeEntityAudit(model?: AuditedModel): string | undefined {
    if (!model) return undefined;
    const parts = [`independently_created: ${model.independently_created}`];
    if (model.creation_function) parts.push(`creation function: ${model.creation_function}`);
    if (model.created_by.length > 0) parts.push(`created by: ${model.created_by.map((c) => c.owner).join(", ")}`);
    if (model.side_effects?.length) parts.push(`side effects: ${model.side_effects.join(", ")}`);
    return parts.join("; ");
}

async function proposeRecipeData(
    entityName: string,
    entityIndex: number,
    totalEntities: number,
    model: LanguageModel,
    outputDir: string,
    _projectRoot: string,
    completedEntities: Record<string, EntityProgress>,
    schemaSpec?: string,
): Promise<Record<string, unknown>[]> {
    let result: Record<string, unknown>[] | undefined;

    const { logger, onStepFinish } = buildDefaultStepLogger(`propose:${entityName}`, 20);

    const finishTool = tool({
        description: "Submit the proposed recipe data as a JSON array of records.",
        inputSchema: z.object({
            records: z.array(z.record(z.string(), z.unknown())).describe("Array of record objects for this entity"),
        }),
        execute: async (input) => {
            result = input.records;
            return { accepted: true };
        },
    });

    const completedAliases = summarizeCompletedAliases(completedEntities, entityName);

    const prompt = `[${entityIndex + 1}/${totalEntities}] Propose recipe data for entity "${entityName}".

Read scenarios.md and entity-audit.md from the output directory. Design records that match the scenario data.

${schemaSpec ? `${schemaSpec}\n` : ""}
${completedAliases ? `Already completed entities (use _ref to reference their aliases):\n${completedAliases}\n` : "This is a root entity - no parent references needed."}

Produce records for "${entityName}" ONLY - one object per record. Do not include records for other models; the tool assembles parent entities automatically.

Call finish with the JSON array of records.`;

    const readOutputTool = buildReadFileTool(outputDir);

    await runAgent(
        {
            id: `propose-${entityName}`,
            systemPrompt: PROPOSAL_PROMPT,
            model,
            maxSteps: 20,
            tools: (_heartbeat: () => void) => ({
                read_output: readOutputTool,
                ask_user: buildAskUserTool(),
                finish: finishTool,
            }),
            onStepFinish,
        },
        prompt,
        () => result,
    );
    logger.summary();

    return result ?? [];
}

async function reviseRecipeData(
    entityName: string,
    entityIndex: number,
    totalEntities: number,
    current: Record<string, unknown>[],
    feedback: string,
    model: LanguageModel,
    outputDir: string,
    completedEntities: Record<string, EntityProgress>,
    schemaSpec?: string,
): Promise<Record<string, unknown>[]> {
    let revised: Record<string, unknown>[] | undefined;

    const finishTool = tool({
        description: "Submit the fixed recipe data.",
        inputSchema: z.object({
            records: z.array(z.record(z.string(), z.unknown())),
        }),
        execute: async (input) => {
            revised = input.records;
            return { done: true };
        },
    });

    const { logger, onStepFinish } = buildDefaultStepLogger(`fix:${entityName}`, 15);

    const completedAliases = summarizeCompletedAliases(completedEntities, entityName);
    const aliasBlock = completedAliases
        ? `Aliases declared by already-created parent entities (these are the ONLY valid _ref targets):\n${completedAliases}\n`
        : `This is a root entity - it has no parent entities to _ref.\n`;

    await runAgent(
        {
            id: `fix-${entityName}`,
            systemPrompt: `You are fixing recipe data based on user feedback (or a validation failure). Read the error, the current data, and the user's feedback. Read scenarios.md and entity-audit.md if needed. Fix the data and call finish.

Rules:
- Return records for "${entityName}" ONLY - a flat JSON array, one object per record. NEVER group records by model name or nest other models (Client/User/etc.) inside this array. The tool assembles parent entities into the request automatically; your job is only this one entity's rows.
- _alias fields must be unique identifiers (e.g., "card_1", "transaction_1")
- _ref fields must reference an alias that ALREADY EXISTS on a parent entity - see the list of valid targets below. Never invent a _ref to an alias that isn't listed.
- If the error says "references unknown alias(es): X", a _ref points at "X" but nothing being created declares it. Correct that _ref to one of the valid targets listed below (it's usually a typo, e.g. "users_1" vs "user_1"), or drop the reference if the field is optional. Do NOT leave a _ref pointing at an alias that isn't in the valid targets list.
- Read scenarios.md to verify you're using correct alias names from parent entities
- Field names and required fields must match the live schema below when present (it is the source of truth), otherwise the entity's schema from entity-audit.md`,
            model,
            maxSteps: 15,
            tools: (_heartbeat: () => void) => ({
                read_output: buildReadFileTool(outputDir),
                finish: finishTool,
            }),
            onStepFinish,
        },
        `[${entityIndex + 1}/${totalEntities}] Fix recipe data for "${entityName}".

Current data:
${JSON.stringify(current, null, 2)}

What's wrong / what to change:
${feedback}

${aliasBlock}
${schemaSpec ? `${schemaSpec}\n` : ""}
Read scenarios.md and entity-audit.md to understand the correct aliases and schema. Apply the change and call finish.`,
        () => revised,
    );
    logger.summary();

    if (revised) {
        p.note(JSON.stringify(revised, null, 2), `Fixed data for ${entityName}`, { format: codeNoteFormat });
        return revised;
    }

    p.log.warn("Could not auto-fix. Returning original data.");
    return current;
}

async function generateInstructions(
    entityName: string,
    entityIndex: number,
    totalEntities: number,
    isFirst: boolean,
    techStack: TechStack,
    auditModel: AuditedModel,
    recipeData: Record<string, unknown>[],
    model: LanguageModel,
    projectRoot: string,
    outputDir: string,
): Promise<string> {
    let result: string | undefined;

    const { logger, onStepFinish } = buildDefaultStepLogger(`instructions:${entityName}`, 15);

    const finishTool = tool({
        description: "Submit the implementation instructions.",
        inputSchema: z.object({
            instructions: z.string().describe("Complete, copy-pasteable implementation instructions"),
        }),
        execute: async (input) => {
            result = input.instructions;
            return { done: true };
        },
    });

    const ignorePatterns = await loadGitignorePatterns(projectRoot);

    const pm = detectPackageManager(projectRoot);
    const installCmd =
        techStack.language === "typescript"
            ? installCommand(pm, techStack.sdkPackage, techStack.adapterPackage)
            : `pip install ${techStack.sdkPackage}[${techStack.framework}]`;

    const setupContext = isFirst
        ? `\nThis is the FIRST entity. Include one-time setup instructions:
- Install SDK: ${installCmd}
- Create the route/endpoint file
- Add env vars: AUTONOMA_SHARED_SECRET, AUTONOMA_SIGNING_SECRET
- Explain: "This single endpoint handles discover/up/down - the SDK routes internally"
- Include the auth callback in createHandler config. The auth callback receives the first User record created during UP and must return real credentials the test runner can use to authenticate. Three patterns:
  - Session cookies (most web apps): create a session, return { cookies: [{ name, value, httpOnly, sameSite, path }] }
  - JWT bearer token (SPAs/APIs): sign a JWT, return { headers: { Authorization: "Bearer <real-token>" } }
  - Email/password (mobile/native login): return { credentials: { email: user.email, password: "the-test-password" } }
  Choose the pattern that matches how this app authenticates users. Read the project's auth code to determine which.\n`
        : "";

    const prompt = `[${entityIndex + 1}/${totalEntities}] Generate implementation instructions for the "${entityName}" factory.
${setupContext}
Entity audit info:
- Creation file: ${auditModel.creation_file ?? "unknown"}
- Creation function: ${auditModel.creation_function ?? "unknown"}
- Side effects: ${auditModel.side_effects?.join(", ") ?? "none"}
- Dependencies: ${auditModel.created_by.map((d) => d.owner).join(", ") || "none (root entity)"}

Accepted recipe data (${recipeData.length} records):
${JSON.stringify(recipeData, null, 2)}

Tech stack: ${adapterLabel(techStack)}

Read the creation file from the project to understand the existing service/function. Then produce instructions.`;

    await runAgent(
        {
            id: `instructions-${entityName}`,
            systemPrompt: INSTRUCTIONS_PROMPT,
            model,
            maxSteps: 15,
            tools: (_heartbeat: () => void) => ({
                read_file: buildReadFileTool(projectRoot),
                read_output: buildReadFileTool(outputDir),
                glob: buildGlobTool(projectRoot, ignorePatterns),
                grep: buildGrepTool(projectRoot),
                finish: finishTool,
            }),
            onStepFinish,
        },
        prompt,
        () => result,
    );
    logger.summary();

    return result ?? "No instructions generated. Check the entity audit for creation_file and creation_function.";
}

async function reviewRecipeData(
    entityName: string,
    entityIndex: number,
    totalEntities: number,
    proposed: Record<string, unknown>[],
    model: LanguageModel,
    outputDir: string,
    completedEntities: Record<string, EntityProgress>,
    schemaSpec?: string,
): Promise<Record<string, unknown>[]> {
    p.log.info(
        "Legend for recipe fields:\n" +
            '  _alias - Internal ID used to reference this record from other entities (e.g., { "_ref": "org_1" })\n' +
            "  _ref   - Reference to a record created by a parent entity's _alias\n" +
            "  All other fields are the actual data that will be inserted into your database.",
    );

    p.note(JSON.stringify(proposed, null, 2), `Proposed data for ${entityName} (${proposed.length} records)`, {
        format: codeNoteFormat,
    });

    p.log.info(
        "Review checklist:\n" +
            "  - Do field values match your real data patterns?\n" +
            "  - Are _ref references pointing to correct parent aliases?\n" +
            "  - Are enum fields varied across records (not all the same value)?\n" +
            "  - Are there enough records for your test scenarios?",
    );

    while (true) {
        const action = await p.select({
            message: `[${entityIndex + 1}/${totalEntities}] ${entityName} - does this data look right?`,
            options: [
                { value: "keep", label: "Yes, keep" },
                { value: "chat", label: "No, let's chat" },
                { value: "edit", label: "No, edit manually" },
            ],
        });

        if (p.isCancel(action)) throw new Error("Recipe review cancelled");

        if (action === "keep") return proposed;

        if (action === "edit") {
            const tmpPath = join(tmpdir(), `autonoma-recipe-${entityName}.json`);
            await writeFile(tmpPath, JSON.stringify(proposed, null, 2), "utf-8");

            const env = readEnv();
            const editor = env.EDITOR ?? env.VISUAL ?? "vi";
            p.log.info(`Opening ${editor}... Save and close when done.`);

            // cross-spawn resolves editor launchers across platforms; a failure to
            // spawn (e.g. no `$EDITOR` and no `vi` on Windows) is reported and the
            // edit is skipped rather than aborting the whole recipe review.
            const launched = await new Promise<boolean>((resolve) => {
                const proc = spawn(editor, [tmpPath], { stdio: "inherit" });
                proc.on("close", () => resolve(true));
                proc.on("error", (err: Error) => {
                    p.log.error(
                        `Couldn't open ${editor} (${err.message}). Edit this file manually, then choose "edit" again: ${tmpPath}`,
                    );
                    resolve(false);
                });
            });

            if (!launched) continue;

            const edited = await readFile(tmpPath, "utf-8");
            try {
                proposed = JSON.parse(edited);
                p.note(JSON.stringify(proposed, null, 2), `Updated data for ${entityName}`, { format: codeNoteFormat });
            } catch (err) {
                p.log.error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}. Try again.`);
            }
            continue;
        }

        if (action === "chat") {
            const feedback = await p.text({
                message: "What should be changed?",
                placeholder: "e.g., add more records, change field values, fix references...",
            });

            if (p.isCancel(feedback) || !feedback.trim()) continue;

            proposed = await reviseRecipeData(
                entityName,
                entityIndex,
                totalEntities,
                proposed,
                feedback.trim(),
                model,
                outputDir,
                completedEntities,
                schemaSpec,
            );
        }
    }
}

type TestResult = "success" | "skip" | { feedback: string };

export function formatErrorContext(errorBody: unknown): string {
    if (errorBody == null) return "";
    const rendered = typeof errorBody === "string" ? errorBody : JSON.stringify(errorBody);
    return `\nServer error: ${rendered}`;
}

/**
 * The most times we'll route a failure into the recipe-fix agent before we stop
 * offering it and hand control back to the user. Autofix regenerates the test
 * data; if that many rounds haven't resolved the failure, the data was never the
 * cause - it's a handler/code issue the agent can't touch.
 */
export const MAX_AUTOFIX_ATTEMPTS = 2;

/** Mutable per-entity counter, threaded through a whole test cycle so auto- and
 *  manual autofix rounds share one budget. */
export interface AutofixBudget {
    attempts: number;
}

export interface FailureContext {
    model: LanguageModel;
    /** The payload that was sent - context for the failure classifier. */
    recipe: unknown;
    budget: AutofixBudget;
    /** Aliases declared by already-created parents - the valid _ref targets. */
    validRefAliases?: string;
    /** What the entity audit recorded about how this entity is created. */
    entityAudit?: string;
    /** This entity's live field schema from /discover, rendered for prompts. */
    liveSchema?: string;
}

function seedFeedbackFromError(errorContext: string, reason?: string): { feedback: string } {
    const triage = reason ? ` (Auto-triage: ${reason})` : "";
    return { feedback: `The request failed - read the error and fix the recipe data.${triage}${errorContext}` };
}

export async function promptOnFailure(
    entityName: string,
    errorBody: unknown,
    ctx: FailureContext,
    phase: FailurePhase,
    httpStatus?: number,
): Promise<"retry" | "skip" | { feedback: string }> {
    notify("Autonoma", `${entityName} - failed, action needed`);
    const errorContext = formatErrorContext(errorBody);

    // Classify the failure for CONTEXT only. The verdict is informational - we hand
    // it to the fix agent and show it to the user, but it never gates which actions
    // are available. (Letting `side` decide that is exactly what hid the autofix on
    // self-evident recipe errors like "references unknown alias(es)".)
    const { reason } = await classifyFailure(ctx.model, {
        entityName,
        phase,
        httpStatus,
        error: errorBody,
        recipe: ctx.recipe,
        validRefAliases: ctx.validRefAliases,
        entityAudit: ctx.entityAudit,
        liveSchema: ctx.liveSchema,
    });

    // While there's budget, always hand the raw failure (plus the triage note as
    // context) straight to the agent and let it decide whether and how to fix the
    // recipe. No "is this recipe-side?" gate in front of it.
    if (ctx.budget.attempts < MAX_AUTOFIX_ATTEMPTS) {
        ctx.budget.attempts++;
        p.log.info(`Triage: ${reason}`);
        p.log.info(
            `Handing the failure to the agent to fix from the error (attempt ${ctx.budget.attempts}/${MAX_AUTOFIX_ATTEMPTS})...`,
        );
        return seedFeedbackFromError(errorContext, reason);
    }

    // Budget spent - the agent's fixes didn't resolve it, so it's most likely your
    // handler code. Hand control back, with every option available (nothing hidden).
    p.log.warn(`The agent tried ${MAX_AUTOFIX_ATTEMPTS}× without resolving it. Latest triage: ${reason}`);
    const action = await p.select({
        message: "What would you like to do?",
        options: [
            { value: "retry", label: "Yes, retry - I fixed my handler code", hint: "Send the same request again" },
            {
                value: "autofix",
                label: "Let the agent try again from the error",
                hint: "Hand the raw error back to the agent, no typing",
            },
            {
                value: "feedback",
                label: "Let me explain what's wrong",
                hint: "Describe the change and the agent will apply it",
            },
            { value: "skip", label: "No, skip this entity", hint: "Move on to the next entity" },
        ],
    });
    if (p.isCancel(action)) throw new Error("Entity loop cancelled");
    if (action === "skip") return "skip";
    if (action === "retry") return "retry";
    if (action === "autofix") {
        ctx.budget.attempts++;
        return seedFeedbackFromError(errorContext, reason);
    }

    const fb = await p.text({
        message: "What's wrong with the recipe data?",
        placeholder: "e.g. Transaction references acc_1 but Account uses account_1 as its alias",
    });
    if (p.isCancel(fb)) throw new Error("Entity loop cancelled");
    return { feedback: `${fb.trim()}${errorContext}` };
}

async function testUpDown(
    entityName: string,
    entityIndex: number,
    totalEntities: number,
    sdkConfig: SdkClientConfig,
    recipe: RecipePayload,
    grounding: Omit<FailureContext, "recipe">,
    discoverSchema?: DiscoverSchema,
): Promise<TestResult> {
    p.log.info(
        `Let's verify this factory works. We'll send a test request to create ${entityName}, then check the database.`,
    );
    const failureCtx: FailureContext = { ...grounding, recipe };

    // UP with retry loop
    while (true) {
        // Pre-flight: catch schema violations locally, before bothering the server,
        // so a missing required field surfaces as a precise diagnostic instead of an
        // opaque HTTP 500. Only validates models the live schema actually knows.
        if (discoverSchema) {
            const problems = validateRecipeAgainstSchema(recipe, discoverSchema);
            if (problems.length > 0) {
                const errorBody = `Recipe failed local schema validation against /discover (not sent to the server):\n${formatValidationProblems(problems)}`;
                p.log.error(errorBody);
                const action = await promptOnFailure(entityName, errorBody, failureCtx, "create");
                if (action === "skip") return "skip";
                if (action === "retry") continue;
                return action;
            }
        }

        const testRunId = `test-${Date.now()}`;

        p.log.step(`[${entityIndex + 1}/${totalEntities}] Sending UP request...`);

        let upResult: Awaited<ReturnType<typeof sdk.up>>;
        try {
            upResult = await sdk.up(sdkConfig, recipe, testRunId);
        } catch (err) {
            p.log.error(`UP request failed:\n${formatException(err)}`);
            const action = await promptOnFailure(entityName, formatException(err), failureCtx, "create");
            if (action === "skip") return "skip";
            if (action === "retry") continue;
            return action;
        }

        if (!upResult.ok) {
            p.log.error(`UP failed (HTTP ${upResult.status}):`);
            console.log(JSON.stringify(upResult.body, null, 2));
            const action = await promptOnFailure(entityName, upResult.body, failureCtx, "create", upResult.status);
            if (action === "skip") return "skip";
            if (action === "retry") continue;
            return action;
        }

        p.log.success(`UP succeeded!`);
        console.log(JSON.stringify(upResult.body, null, 2));

        const refsTokenValue = toRecord(upResult.body).refsToken;
        const refsToken = typeof refsTokenValue === "string" ? refsTokenValue : undefined;
        if (!refsToken) {
            p.log.error("No refsToken in UP response - cannot test DOWN.");
            return "skip";
        }

        // DOWN with retry loop
        p.log.info("Now let's verify teardown works - leftover test data would pollute your database.");
        while (true) {
            p.log.step(`[${entityIndex + 1}/${totalEntities}] Sending DOWN request...`);

            let downResult: Awaited<ReturnType<typeof sdk.down>>;
            try {
                downResult = await sdk.down(sdkConfig, refsToken);
            } catch (err) {
                p.log.error(`DOWN request failed:\n${formatException(err)}`);
                const action = await promptOnFailure(entityName, formatException(err), failureCtx, "teardown");
                if (action === "skip") return "skip";
                if (action === "retry") continue;
                return action;
            }

            if (!downResult.ok) {
                p.log.error(`DOWN failed (HTTP ${downResult.status}):`);
                console.log(JSON.stringify(downResult.body, null, 2));
                const action = await promptOnFailure(
                    entityName,
                    downResult.body,
                    failureCtx,
                    "teardown",
                    downResult.status,
                );
                if (action === "skip") return "skip";
                if (action === "retry") continue;
                return action;
            }

            p.log.success("DOWN succeeded!");
            return "success";
        }
    }
}

export async function runEntityLoop(
    state: RecipeBuilderState,
    models: AuditedModel[],
    model: LanguageModel,
    projectRoot: string,
    outputDir: string,
    nonInteractive?: boolean,
): Promise<void> {
    const total = state.entityOrder.length;
    const modelMap = new Map(models.map((m) => [m.name, m]));

    // Best-effort live schema from the SDK's /discover endpoint. It is the source
    // of truth for each factory's required fields and types, so we use it to
    // ground recipe generation instead of guessing from the markdown audit.
    // Refetched per use rather than cached: discover only reflects the factories
    // registered SO FAR, and that set grows as the developer wires up entities.
    async function loadLiveSchema(name: string): Promise<{ schema?: DiscoverSchema; spec?: string }> {
        if (!state.sdkEndpointUrl || !state.sharedSecret) return {};
        const schema = await fetchDiscoverSchema({
            endpointUrl: state.sdkEndpointUrl,
            sharedSecret: state.sharedSecret,
        });
        if (!schema) return {};
        return { schema, spec: renderModelSchema(schema, name) ?? undefined };
    }

    p.log.info(
        `We're going to set up your test data factories one entity at a time. Each factory teaches the Autonoma SDK how to create and tear down a specific type of record in YOUR database, using YOUR existing service functions.\n\n  We'll test each one live before moving on - this way if something breaks, you'll know exactly which entity caused it. Let's start with the root entities (no dependencies), then work through the dependents.`,
    );

    for (let i = state.currentEntityIndex; i < total; i++) {
        const entityName = state.entityOrder[i]!;
        const auditModel = modelMap.get(entityName);
        if (!auditModel) {
            p.log.warn(`[${i + 1}/${total}] ${entityName} - not found in entity audit, skipping`);
            state.entities[entityName] = {
                entityName,
                status: "skipped",
                errorLog: ["Not found in entity audit"],
            };
            state.currentEntityIndex = i + 1;
            await saveRecipeState(outputDir, state);
            continue;
        }

        const existing = state.entities[entityName];
        if (existing?.status === "tested-down") {
            p.log.info(`[${i + 1}/${total}] ${entityName} - already done, skipping`);
            continue;
        }

        const isRoot = auditModel.created_by.length === 0;
        const depInfo = isRoot
            ? "This is a root entity - no dependencies."
            : `This depends on: ${auditModel.created_by.map((d) => d.owner).join(", ")}`;

        p.log.step(`[${i + 1}/${total}] ${entityName}`);
        p.log.info(depInfo);

        // Live schema for grounding propose/review (null until the endpoint is
        // configured - i.e. from the second entity onward, or a resumed run).
        const { spec: recipeSchemaSpec } = await loadLiveSchema(entityName);

        // A. Propose recipe data
        let recipeData = existing?.recipeData;
        if (!recipeData || existing?.status === "pending") {
            recipeData = await proposeRecipeData(
                entityName,
                i,
                total,
                model,
                outputDir,
                projectRoot,
                state.entities,
                recipeSchemaSpec,
            );
        }

        // B. User review
        if (!nonInteractive) {
            recipeData = await reviewRecipeData(
                entityName,
                i,
                total,
                recipeData,
                model,
                outputDir,
                state.entities,
                recipeSchemaSpec,
            );
        }

        state.entities[entityName] = {
            entityName,
            status: "recipe-accepted",
            recipeData,
            errorLog: existing?.errorLog ?? [],
        };
        state.currentEntityIndex = i;
        await saveRecipeState(outputDir, state);

        // C. Implementation instructions
        if (!nonInteractive) {
            const instructions = await generateInstructions(
                entityName,
                i,
                total,
                i === 0,
                state.techStack!,
                auditModel,
                recipeData,
                model,
                projectRoot,
                outputDir,
            );
            const DOCS_BASE = "https://docs.autonoma.app";

            p.log.info(
                `Next: implement the ${entityName} factory. The block below is a copy-paste guide -\n` +
                    `  paste it into Claude Code (or your AI assistant) and it will write the factory in your codebase.\n` +
                    `  A factory teaches the Autonoma SDK how to create and tear down ${entityName} records using your app's own code.\n` +
                    `  Keep it local for now: implement it, run your app on localhost, and we'll test it live here. You deploy later.`,
            );

            p.note(instructions, `Implementation guide for ${entityName} (paste into your AI assistant)`, {
                format: codeNoteFormat,
            });

            p.log.info(`Autonoma SDK docs: ${DOCS_BASE}/sdk/environment-factory`);

            if (i === 0) {
                p.log.info(
                    "This is your first factory - the guide includes one-time SDK setup. Later entities only need the factory function.",
                );
            }

            notify("Autonoma", `${entityName} - implementation ready, waiting for you`);
            const ready = await p.confirm({
                message: `[${i + 1}/${total}] Is your app running locally with the ${entityName} factory wired up?`,
            });
            if (p.isCancel(ready)) throw new Error("Entity loop cancelled");

            if (!ready) {
                p.log.info("Take your time implementing. Run again with --resume to continue from here.");
                return;
            }
        }

        // D + E. Test UP/DOWN
        if (!nonInteractive && state.techStack) {
            if (!state.sharedSecret) {
                const bytes = new Uint8Array(32);
                crypto.getRandomValues(bytes);
                const secret = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
                state.sharedSecret = secret;
                await saveRecipeState(outputDir, state);

                await writeFile(
                    join(outputDir, "autonoma-config.json"),
                    JSON.stringify({ sharedSecret: secret, endpointUrl: state.sdkEndpointUrl }, null, 2),
                    "utf-8",
                );

                p.note(
                    `AUTONOMA_SHARED_SECRET=${secret}\n\n` +
                        `Add this to your server's .env file and restart it.\n` +
                        `This is a 64-character hex key used for HMAC-SHA256 request signing.\n` +
                        `The same value must be set in both your server and the Autonoma dashboard.\n\n` +
                        `Saved to: ${join(outputDir, "autonoma-config.json")}`,
                    "Shared secret generated",
                );

                const secretReady = await p.confirm({
                    message: "Did you add the secret to your .env and restart the server?",
                });
                if (p.isCancel(secretReady)) throw new Error("Entity loop cancelled");
                if (!secretReady) {
                    p.log.info("Add the secret and run again with --resume to continue.");
                    return;
                }
            }

            if (!state.sdkEndpointUrl) {
                const url = await p.text({
                    message: "What's your SDK endpoint URL?",
                    placeholder: "http://localhost:3000/api/autonoma",
                    defaultValue: "http://localhost:3000/api/autonoma",
                });
                if (p.isCancel(url)) throw new Error("Entity loop cancelled");
                state.sdkEndpointUrl = url.trim() || "http://localhost:3000/api/autonoma";
                await saveRecipeState(outputDir, state);

                await writeFile(
                    join(outputDir, "autonoma-config.json"),
                    JSON.stringify({ sharedSecret: state.sharedSecret, endpointUrl: state.sdkEndpointUrl }, null, 2),
                    "utf-8",
                );
            }

            const sdkConfig: SdkClientConfig = {
                endpointUrl: state.sdkEndpointUrl,
                sharedSecret: state.sharedSecret,
            };

            // Now that the endpoint is configured, pull the live schema once for the
            // whole test cycle: it grounds the classifier, pre-flight validation, and
            // any recipe fixes the agent makes from a failure.
            const { schema: discoverSchema, spec: liveSchemaSpec } = await loadLiveSchema(entityName);

            // One autofix budget per entity test cycle - auto- and manual autofix
            // rounds share it, so a wrongly "recipe"-classified failure can't loop forever.
            const autofixBudget: AutofixBudget = { attempts: 0 };
            // Grounding for the failure classifier: which _ref targets are valid, what
            // the audit knows about how this entity is created, and the live schema.
            const grounding: Omit<FailureContext, "recipe"> = {
                model,
                budget: autofixBudget,
                validRefAliases: summarizeCompletedAliases(state.entities, entityName),
                entityAudit: summarizeEntityAudit(models.find((m) => m.name === entityName)),
                liveSchema: liveSchemaSpec,
            };
            let testDone = false;
            while (!testDone) {
                const singleRecipe = buildSingleEntityRecipe(entityName, models, state.entityOrder, state.entities);
                const testResult = await testUpDown(
                    entityName,
                    i,
                    total,
                    sdkConfig,
                    singleRecipe,
                    grounding,
                    discoverSchema ?? undefined,
                );

                if (testResult === "success") {
                    state.entities[entityName]!.status = "tested-down";
                    p.log.success(`[${i + 1}/${total}] ${entityName} - factory verified`);
                    testDone = true;
                } else if (testResult === "skip") {
                    state.entities[entityName]!.status = "skipped";
                    state.entities[entityName]!.errorLog.push("UP/DOWN test skipped by user");
                    p.log.warn(`[${i + 1}/${total}] ${entityName} - skipped, continuing to next entity`);
                    testDone = true;
                } else {
                    p.log.info(`Re-generating recipe data for ${entityName} based on your feedback...`);
                    const revised = await reviseRecipeData(
                        entityName,
                        i,
                        total,
                        state.entities[entityName]!.recipeData!,
                        testResult.feedback,
                        model,
                        outputDir,
                        state.entities,
                        liveSchemaSpec,
                    );
                    state.entities[entityName]!.recipeData = revised;
                    await saveRecipeState(outputDir, state);
                }
            }
        } else if (nonInteractive) {
            state.entities[entityName]!.status = "tested-down";
        }

        state.currentEntityIndex = i + 1;
        await saveRecipeState(outputDir, state);
    }
}
