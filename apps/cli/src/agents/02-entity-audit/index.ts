import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tool } from "ai";
import { glob } from "glob";
import { z } from "zod";
import { runAgent, buildDefaultStepLogger, formatRetryGuidance, type AgentResult } from "../../core/agent";
import { type ProjectContext, formatContext } from "../../core/context";
import { debugLog } from "../../core/debug";
import { formatException } from "../../core/errors";
import { getModel } from "../../core/model";
import { reportSubProgress } from "../../core/progress";
import { buildCodebaseTools } from "../../tools";
import { buildAskUserTool } from "../../tools/ask-user";
import { SYSTEM_PROMPT } from "./prompt";

// Each model costs the agent ~2 steps (grep for its creation path, mark it audited), so a
// large shared schema needs headroom well above a typical app's. At 200 the agent step-outs
// mid-audit; 400 covers ~200 models with the safety net still catching anything larger.
const MAX_STEPS = 400;

export interface EntityAuditInput {
    projectRoot: string;
    outputDir: string;
    modelId?: string;
    projectContext?: ProjectContext;
    nonInteractive?: boolean;
    retryGuidance?: string;
    /**
     * Optional scope hint from the project map: which backend(s)/data-layer(s) own the
     * models to audit, so a monorepo run stays on the selected schema instead of the
     * whole tree. Appended to the task prompt; never edits the tuned system prompt.
     */
    scopeHint?: string;
}

interface CreatedByEntry {
    owner: string;
    via?: string;
    why?: string;
}

interface AuditedModel {
    name: string;
    independently_created: boolean;
    creation_file?: string;
    creation_function?: string;
    side_effects?: string[];
    created_by: CreatedByEntry[];
}

class ModelTracker {
    registered = new Set<string>();
    auditedModels = new Map<string, AuditedModel>();
    creationFilesRead = new Set<string>();
    framework = "unknown";
    queue: string[] = [];
    currentModel?: string;

    register(models: string[]) {
        for (const m of models) this.registered.add(m);
        reportSubProgress("entityAudit", this.auditedModels.size, this.registered.size, "models");
    }

    initQueue() {
        this.queue = [...this.registered].filter((m) => !this.auditedModels.has(m));
    }

    nextModel(): { model: string; remaining: number } | undefined {
        if (this.currentModel && !this.auditedModels.has(this.currentModel)) {
            this.auditedModels.set(this.currentModel, {
                name: this.currentModel,
                independently_created: false,
                created_by: [],
            });
        }
        while (this.queue.length > 0) {
            const model = this.queue.shift()!;
            if (this.auditedModels.has(model)) continue;
            this.currentModel = model;
            return { model, remaining: this.queue.length };
        }
        this.currentModel = undefined;
        return undefined;
    }

    markAudited(model: AuditedModel) {
        this.auditedModels.set(model.name, model);
        reportSubProgress("entityAudit", this.auditedModels.size, this.registered.size, "models");
    }

    markFileRead(filePath: string) {
        this.creationFilesRead.add(filePath);
    }

    unaudited(): string[] {
        return [...this.registered].filter((m) => !this.auditedModels.has(m));
    }

    coverage() {
        return {
            totalModels: this.registered.size,
            audited: this.auditedModels.size,
            unaudited: this.unaudited(),
            creationFilesRead: this.creationFilesRead.size,
        };
    }

    generateAuditMarkdown(): string {
        const models = [...this.auditedModels.values()];
        const roots = models.filter((m) => m.independently_created);
        const dependents = models.filter((m) => !m.independently_created);
        const duals = models.filter((m) => m.independently_created && m.created_by.length > 0);

        const yamlModels = models
            .map((m) => {
                let entry = `  - name: ${m.name}\n    independently_created: ${m.independently_created}`;
                if (m.creation_file) entry += `\n    creation_file: ${m.creation_file}`;
                if (m.creation_function) entry += `\n    creation_function: ${m.creation_function}`;
                if (m.side_effects && m.side_effects.length > 0) {
                    entry += `\n    side_effects:\n${m.side_effects.map((s) => `      - ${s}`).join("\n")}`;
                }
                if (m.created_by.length > 0) {
                    entry += `\n    created_by:`;
                    for (const cb of m.created_by) {
                        entry += `\n      - owner: ${cb.owner}`;
                        if (cb.via) entry += `\n        via: ${cb.via}`;
                        if (cb.why) entry += `\n        why: "${cb.why}"`;
                    }
                } else {
                    entry += `\n    created_by: []`;
                }
                return entry;
            })
            .join("\n");

        return `---
model_count: ${models.length}
factory_count: ${roots.length}
models:
${yamlModels}
---

# Entity Audit

Framework: ${this.framework}

## Roots (independently_created: true)

${roots.map((m) => `- **${m.name}** - ${m.creation_function ?? m.creation_file ?? "unknown"}`).join("\n")}

## Dependents (independently_created: false)

${dependents.map((m) => `- **${m.name}** - created by: ${m.created_by.map((cb) => `${cb.owner}${cb.via ? ` via ${cb.via}` : ""}`).join(", ") || "unknown"}`).join("\n")}

## Dual-creation models (independently_created AND created_by)

${duals.length > 0 ? duals.map((m) => `- **${m.name}** - standalone: ${m.creation_function ?? m.creation_file ?? "unknown"}, also created by: ${m.created_by.map((cb) => cb.owner).join(", ")}`).join("\n") : "None"}
`;
    }
}

function buildRegisterModelsTool(tracker: ModelTracker) {
    return tool({
        description:
            "Register ALL database models discovered via grep. " +
            "Call this ONCE after grepping for model definitions. " +
            "After registering, use next_model to process them one at a time.",
        inputSchema: z.object({
            models: z.array(z.string()).describe("All model/table names found by grep"),
            framework: z.string().describe("Database framework detected (e.g. 'sqlalchemy', 'prisma', 'drizzle')"),
        }),
        execute: async (input) => {
            tracker.register(input.models);
            tracker.initQueue();
            return {
                registered: input.models.length,
                framework: input.framework,
                message: `Registered ${input.models.length} models (${input.framework}). Call next_model to start processing them one at a time.`,
            };
        },
    });
}

function buildNextModelTool(tracker: ModelTracker) {
    return tool({
        description:
            "Get the next model to audit from the queue. If you called next_model before " +
            "without calling mark_model_audited, the previous model is auto-skipped " +
            "(marked as no creation path found). Returns done:true when all models are processed.",
        inputSchema: z.object({}),
        execute: async () => {
            const next = tracker.nextModel();
            if (!next) {
                return {
                    done: true,
                    message: `All models processed (${tracker.auditedModels.size} total). Write entity-audit.md and call finish.`,
                };
            }
            return {
                model: next.model,
                remaining: next.remaining,
                instruction: `Audit "${next.model}": grep for its creation paths, read the relevant file, then call mark_model_audited. If you can't find how it's created after 2-3 greps, call next_model to skip it.`,
            };
        },
    });
}

function buildMarkModelAuditedTool(tracker: ModelTracker) {
    return tool({
        description:
            "Mark a model as audited after you have determined its creation paths. " +
            "Call this for EACH model after reading its creation code and determining independently_created + created_by. " +
            "Include creation_function (e.g. 'UserService.create'), side_effects (list of things the creation does beyond the model itself), " +
            "and for each created_by entry include owner, via (function name), and why (one sentence explaining the relationship).",
        inputSchema: z.object({
            model: z.string().describe("Model name"),
            independently_created: z.boolean(),
            creation_file: z.string().optional().describe("File containing the creation function"),
            creation_function: z
                .string()
                .optional()
                .describe("Function/method name (e.g. 'UserService.create' or 'create_user')"),
            side_effects: z
                .array(z.string())
                .optional()
                .describe("Side effects of creation (e.g. 'creates default Settings row', 'hashes password')"),
            created_by: z
                .array(
                    z.object({
                        owner: z.string().describe("Owner model name"),
                        via: z
                            .string()
                            .optional()
                            .describe("Function that creates this model (e.g. 'OrganizationService.create')"),
                        why: z
                            .string()
                            .optional()
                            .describe("One sentence explaining why this model is created as a side effect"),
                    }),
                )
                .describe("List of owner models that create this as a side effect, empty array if none"),
        }),
        execute: async (input) => {
            let modelName = input.model;

            if (tracker.registered.size > 0 && !tracker.registered.has(modelName)) {
                const exact = [...tracker.registered].find(
                    (r) => r.toLowerCase() === modelName.toLowerCase() || modelName.startsWith(r),
                );
                if (exact) {
                    modelName = exact;
                } else {
                    return {
                        error: `"${modelName}" is not a registered model. Use the exact name from register_models. Registered: ${[...tracker.registered].join(", ")}`,
                    };
                }
            }

            tracker.markAudited({
                name: modelName,
                independently_created: input.independently_created,
                creation_file: input.creation_file,
                creation_function: input.creation_function,
                side_effects: input.side_effects,
                created_by: input.created_by,
            });
            if (input.creation_file) tracker.markFileRead(input.creation_file);
            const cov = tracker.coverage();
            return {
                model: modelName,
                progress: `${cov.audited}/${cov.totalModels} models audited`,
                remaining: cov.unaudited.length,
            };
        },
    });
}

function buildModelCoverageTool(tracker: ModelTracker) {
    return tool({
        description: "Check how many registered models you've audited vs how many remain.",
        inputSchema: z.object({}),
        execute: async () => tracker.coverage(),
    });
}

function buildFinishTool(tracker: ModelTracker, onFinish: (result: AgentResult) => void) {
    return tool({
        description:
            "Call when entity audit is complete. " +
            "BLOCKED if there are unaudited models - call model_coverage first to check.",
        inputSchema: z.object({
            summary: z.string().describe("Summary of the audit"),
            artifacts: z.array(z.string()).describe("Files written"),
        }),
        execute: async (input) => {
            const cov = tracker.coverage();
            if (cov.unaudited.length > 0) {
                return {
                    error: `Cannot finish: ${cov.unaudited.length}/${cov.totalModels} models not yet audited. Audit these models first:\n${cov.unaudited.join("\n")}`,
                };
            }
            onFinish({
                success: true,
                artifacts: input.artifacts,
                summary: input.summary,
            });
            return { success: true };
        },
    });
}

type FrameworkDetection = {
    framework: string;
    models: string[];
    schemaFile?: string;
};

async function findPrismaSchema(projectRoot: string): Promise<string | undefined> {
    const candidates = await glob("**/schema.prisma", {
        cwd: projectRoot,
        ignore: ["**/node_modules/**"],
        absolute: true,
    });
    return candidates[0] ?? undefined;
}

async function extractPrismaModels(schemaPath: string): Promise<string[]> {
    const content = await readFile(schemaPath, "utf-8");
    return content
        .split("\n")
        .filter((line) => line.startsWith("model "))
        .map((line) => line.split(/\s+/)[1])
        .filter((name): name is string => name != null);
}

async function detectFrameworkAndModels(projectRoot: string): Promise<FrameworkDetection | undefined> {
    const prismaPath = await findPrismaSchema(projectRoot);
    if (prismaPath) {
        const models = await extractPrismaModels(prismaPath);
        return { framework: "prisma", models, schemaFile: prismaPath };
    }

    // TODO: Add SQLAlchemy, Django, Drizzle, TypeORM detection
    return undefined;
}

export async function runEntityAudit(input: EntityAuditInput): Promise<AgentResult> {
    const model = getModel(input.modelId);

    let result: AgentResult | undefined;
    const tracker = new ModelTracker();

    const detection = await detectFrameworkAndModels(input.projectRoot);
    let preRegisteredCount = 0;
    if (detection) {
        tracker.framework = detection.framework;
        tracker.register(detection.models);
        tracker.initQueue();
        preRegisteredCount = detection.models.length;
    }

    const { logger, onStepFinish } = buildDefaultStepLogger("entity-audit", MAX_STEPS);

    const scopeBlock = input.scopeHint != null ? `\n${input.scopeHint}\n` : "";
    const contextBlock =
        (input.projectContext ? "\n" + formatContext(input.projectContext) + "\n" : "") +
        scopeBlock +
        formatRetryGuidance(input.retryGuidance);

    const preRegBlock =
        preRegisteredCount > 0
            ? `\n## Pre-registered models (${preRegisteredCount} found via ${detection!.framework} schema at ${detection!.schemaFile})

The system has already registered ${preRegisteredCount} models from the schema file. You do NOT need to call register_models - it's already done. Start with next_model to process them.\n`
            : "";

    const prompt = `Use read_output to read AUTONOMA.md from the output directory to understand the application.

${contextBlock}
Audit the codebase at the working directory.
${preRegBlock}
MANDATORY PROCESS:

${
    preRegisteredCount === 0
        ? `1. Explore the project to identify the database framework and find ALL model definitions
2. Call register_models with the full list of model names
3. Call next_model`
        : "1. Call next_model"
} to get the first model
${preRegisteredCount === 0 ? "4" : "2"}. For each model returned by next_model:
   a. grep for creation patterns (e.g. "ModelName.create", "new ModelName") - 1 to 3 greps MAX
   b. If found: read the file, call mark_model_audited with the creation details
   c. If NOT found after 2-3 greps: call next_model to skip and move on (auto-skipped as "no creation path found")
${preRegisteredCount === 0 ? "5" : "3"}. Repeat until next_model returns done
${preRegisteredCount === 0 ? "6" : "4"}. Write entity-audit.md with all findings
${preRegisteredCount === 0 ? "7" : "5"}. Call finish

IMPORTANT: Do NOT spend more than 3-4 steps per model. The queue ensures you process every model.
If you can't find a creation path quickly, skip it - that's valid data.
After every 10 mark_model_audited calls, use write_file to update entity-audit.md progressively.
write_file already targets the output directory - use just the filename.`;

    const agentConfig = {
        id: "entity-audit",
        systemPrompt: SYSTEM_PROMPT,
        model,
        maxSteps: MAX_STEPS,
        tools: async (heartbeat: () => void) => {
            const tools = await buildCodebaseTools(model, input.projectRoot, input.outputDir, heartbeat);
            return {
                ...tools,
                register_models: buildRegisterModelsTool(tracker),
                next_model: buildNextModelTool(tracker),
                mark_model_audited: buildMarkModelAuditedTool(tracker),
                model_coverage: buildModelCoverageTool(tracker),
                ask_user: buildAskUserTool(),
                finish: buildFinishTool(tracker, (r) => {
                    result = r;
                }),
            };
        },
        onStepFinish,
    };

    let agentError: string | undefined;
    try {
        await runAgent(agentConfig, prompt, () => result);
    } catch (err) {
        agentError = err instanceof Error ? err.message : String(err);
        console.error(`Entity audit agent error:\n${formatException(err)}`);
    }
    logger.summary();

    // The frontmatter in entity-audit.md is the contract every later step parses,
    // and the tracker holds the authoritative structured data (one entry per
    // mark_model_audited call). Always (re)write the file from the tracker so the
    // on-disk frontmatter is guaranteed well-formed - the agent's own write_file
    // occasionally emitted a file with missing or garbled frontmatter, which used
    // to crash the recipe builder downstream with "no YAML frontmatter".
    const writeCanonicalAudit = async (): Promise<string | undefined> => {
        if (tracker.auditedModels.size === 0) return undefined;
        const auditPath = join(input.outputDir, "entity-audit.md");
        await writeFile(auditPath, tracker.generateAuditMarkdown(), "utf-8");
        return auditPath;
    };

    const canonicalPath = await writeCanonicalAudit();
    if (!result && canonicalPath) {
        const cov = tracker.coverage();
        result = {
            success: true,
            artifacts: [canonicalPath],
            summary: `Safety net: agent ran out of steps but audited ${cov.audited}/${cov.totalModels} models. File written from tracker data.`,
        };
    }

    // Output review happens live in the TUI - the run no longer stops to ask.
    const reviewed = result;

    if (!reviewed) {
        const auditPath = join(input.outputDir, "entity-audit.md");
        try {
            await readFile(auditPath, "utf-8");
            return {
                success: true,
                artifacts: ["entity-audit.md"],
                summary:
                    "Entity audit generated (finish tool may not have captured the result, but entity-audit.md exists).",
            };
        } catch (err) {
            debugLog("entity-audit.md not readable; falling back to reviewed result", { err });
        }
    }

    return (
        reviewed ?? {
            success: false,
            artifacts: [],
            summary: agentError
                ? `Entity audit failed: ${agentError}`
                : "Entity audit agent stopped without producing entity-audit.md",
        }
    );
}
