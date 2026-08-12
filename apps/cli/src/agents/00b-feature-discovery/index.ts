import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type LanguageModel, tool } from "ai";
import { z } from "zod";
import { type AgentResult, buildDefaultStepLogger, runAgent } from "../../core/agent";
import { resolveModel } from "../../core/model";
import { buildCodebaseTools } from "../../tools";

const FEATURES_FILE = "features.json";

const Feature = z.object({
    name: z
        .string()
        .min(1)
        .describe("Human-readable name (e.g. 'Settings > Notifications Tab', 'Create Project Modal')"),
    type: z.enum(["tab", "modal", "form", "table", "wizard", "nested-route", "complex-component"]),
    parentPagePath: z.string().min(1).describe("The page path this feature belongs to (from the pages list)"),
    sourceFiles: z.array(z.string()).min(1).describe("Relative paths to the source files for this sub-feature"),
    interactiveElements: z
        .number()
        .int()
        .min(0)
        .describe("Count of interactive elements found (buttons, inputs, toggles, etc.)"),
    description: z.string().min(10).describe("What this sub-feature does"),
});
export type DiscoveredFeature = z.infer<typeof Feature> & { id: string };

class FeatureCollector {
    readonly features = new Map<string, DiscoveredFeature>();

    addFeature(id: string, feature: z.infer<typeof Feature>): void {
        if (this.features.has(id)) {
            console.warn(`feature ${id} already exists, overwriting`);
        }
        this.features.set(id, { ...feature, id });
    }

    viewFeatures(): string {
        if (this.features.size === 0) return "No features discovered yet.";
        const grouped = new Map<string, DiscoveredFeature[]>();
        for (const f of this.features.values()) {
            const existing = grouped.get(f.parentPagePath) ?? [];
            existing.push(f);
            grouped.set(f.parentPagePath, existing);
        }
        const lines: string[] = [];
        for (const [page, features] of grouped) {
            lines.push(`\n${page}:`);
            for (const f of features) {
                lines.push(
                    `  - [${f.type}] ${f.name} (${f.interactiveElements} elements, ${f.sourceFiles.length} files)`,
                );
            }
        }
        return lines.join("\n");
    }
}

export interface FeatureDiscoveryInput {
    /**
     * An already-built model, used in place of `modelId`. The product never passes
     * this; the evals do, so the pipeline can be driven against a provider directly
     * rather than through the authenticated proxy `getModel` requires.
     */
    model?: LanguageModel;
    projectRoot: string;
    outputDir: string;
    modelId?: string;
    pages: Map<string, { route: string; path: string; description: string }>;
    nonInteractive?: boolean;
}

export async function saveFeatures(outputDir: string, features: Map<string, DiscoveredFeature>): Promise<void> {
    const obj = Object.fromEntries(features);
    await writeFile(join(outputDir, FEATURES_FILE), JSON.stringify(obj, null, 2), "utf-8");
}

export async function loadFeatures(outputDir: string): Promise<Map<string, DiscoveredFeature> | undefined> {
    try {
        const raw = await readFile(join(outputDir, FEATURES_FILE), "utf-8");
        const obj = JSON.parse(raw);
        return new Map(Object.entries(obj));
    } catch {
        return undefined;
    }
}

const SYSTEM_PROMPT = `You are a feature discovery agent. Your job is to explore each page's source code and discover all sub-features that deserve their own test coverage.

You will be given a list of pages. For each page, you must:
1. Read the page's source file
2. Follow imports - use grep and glob to find all related components, utilities, hooks
3. For each sub-feature you find, call add_feature

## What counts as a sub-feature
- **Tabs** that render different content (each tab = separate feature)
- **Modals/dialogs** with their own form or workflow
- **CRUD forms** (create entity, edit entity - each is a separate feature)
- **Tables** with row-level actions (edit, delete, status change per row)
- **Multi-step wizards** or flows
- **Nested routes** that render distinct views within the page
- **Complex components** with significant interactive elements (3+ buttons/inputs/toggles)

## What does NOT count
- Pure display components (headers, footers, breadcrumbs, loading spinners)
- Shared UI primitives used across the app (generic Button, Input, Dropdown components)
- Error/loading/empty states
- Simple navigation elements (links, back buttons)

## How to count interactive elements
For each sub-feature, count: buttons, text inputs, toggles/switches, checkboxes, radio buttons, dropdowns/selects, sliders, drag handles, date pickers, file uploads, rich text editors, search fields, table row actions.

## Process
1. Call view_pages to see all pages
2. For each page:
   a. Read the page's source file
   b. Find all imports and trace them to their source files
   c. Identify sub-features by looking for: tab components, modal/dialog components, form components, table components with actions, stepper/wizard components
   d. For each sub-feature, read its source files and count interactive elements
   e. Call add_feature for each sub-feature found
3. After processing all pages, call view_features to review your work
4. Call finish

## ID format
Use kebab-case IDs that indicate the parent page and feature type:
- "settings-notifications-tab"
- "projects-create-modal"
- "users-table-actions"
- "onboarding-step-2-form"

## Important
- Explore the ACTUAL source code. Do not guess what sub-features exist.
- If a page is simple (just displays content, no interactive sub-features), skip it - not every page needs sub-features.
- Focus on features that would need DIFFERENT tests, not variations of the same thing.
- Use spawn_researcher or subagent for pages with many files to avoid context bloat.`;

export async function runFeatureDiscovery(input: FeatureDiscoveryInput): Promise<Map<string, DiscoveredFeature>> {
    const model = resolveModel(input);
    const collector = new FeatureCollector();

    let result: AgentResult | undefined;
    const { logger, onStepFinish } = buildDefaultStepLogger("feature-discovery", 300);

    const pagesDescription = Array.from(input.pages.entries())
        .map(([path, page]) => `- ${page.route} → ${path}\n  ${page.description}`)
        .join("\n");

    const prompt = `Discover sub-features for all pages in this project.

Project root: ${input.projectRoot}

## Pages to analyze
${pagesDescription}

Process every page. Call add_feature for each sub-feature you discover. When done, call finish.`;

    const agentConfig = {
        id: "feature-discovery",
        systemPrompt: SYSTEM_PROMPT,
        model,
        maxSteps: 300,
        tools: async (heartbeat: () => void) => {
            const tools = await buildCodebaseTools(model, input.projectRoot, input.outputDir, heartbeat);
            return {
                ...tools,
                add_feature: tool({
                    description: "Add a discovered sub-feature",
                    inputSchema: Feature.extend({
                        id: z.string().min(1).describe("Unique kebab-case ID (e.g. 'settings-notifications-tab')"),
                    }),
                    execute: (featureInput) => {
                        const { id, ...rest } = featureInput;
                        const parsed = Feature.safeParse(rest);
                        if (!parsed.success) {
                            return `Invalid feature: ${parsed.error.issues.map((i) => i.message).join(", ")}`;
                        }
                        collector.addFeature(id, parsed.data);
                        return `Feature "${id}" added (${collector.features.size} total)`;
                    },
                }),
                view_features: tool({
                    description: "View all discovered features so far",
                    inputSchema: z.object({}),
                    execute: () => collector.viewFeatures(),
                }),
                view_pages: tool({
                    description: "View the pages list to know what to analyze",
                    inputSchema: z.object({}),
                    execute: () => pagesDescription,
                }),
                finish: tool({
                    description: "Signal that feature discovery is complete",
                    inputSchema: z.object({ summary: z.string() }),
                    execute: async (finishInput) => {
                        result = {
                            success: true,
                            artifacts: [...collector.features.keys()],
                            summary: finishInput.summary,
                        };
                        await saveFeatures(input.outputDir, collector.features);
                        return { done: true, featureCount: collector.features.size };
                    },
                }),
            };
        },
        onStepFinish,
    };

    await runAgent(agentConfig, prompt, () => result);
    logger.summary();

    if (collector.features.size > 0 && !result) {
        await saveFeatures(input.outputDir, collector.features);
    }

    return collector.features;
}
