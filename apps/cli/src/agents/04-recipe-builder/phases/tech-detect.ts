import * as p from "@clack/prompts";
import { tool } from "ai";
import { z } from "zod";
import { runAgent, buildDefaultStepLogger } from "../../../core/agent";
import { loadGitignorePatterns } from "../../../core/gitignore";
import { getModel } from "../../../core/model";
import { buildReadFileTool, buildGlobTool, buildGrepTool, buildBashTool } from "../../../tools";
import { ALL_ADAPTERS, ADAPTER_HINTS, adapterKey, adapterLabel, findAdapter, type TechStack } from "../state";

const DOCS_BASE = "https://docs.autonoma.app";

const SYSTEM_PROMPT = `You are a backend technology detector. Your job is to identify the programming language and web framework used by a project's backend/API server.

Explore the project files to detect:
1. The programming language (check package.json, requirements.txt, go.mod, Gemfile, pom.xml, composer.json, Cargo.toml, mix.exs)
2. The web framework (check imports, config files, middleware setup)

When done, call finish with your findings.`;

export async function detectTechStack(
    projectRoot: string,
    modelId?: string,
    nonInteractive?: boolean,
): Promise<TechStack> {
    const model = getModel(modelId);
    const ignorePatterns = await loadGitignorePatterns(projectRoot);

    let detected: { language: string; framework: string } | undefined;

    const { logger, onStepFinish } = buildDefaultStepLogger("tech-detect", 10);

    const finishTool = tool({
        description: "Report the detected backend technology stack.",
        inputSchema: z.object({
            language: z
                .string()
                .describe("Programming language: typescript, python, go, ruby, java, php, rust, elixir"),
            framework: z
                .string()
                .describe(
                    "Web framework: express, node, hono, web, flask, fastapi, django, gin, rails, rack, spring, laravel, axum, actix, plug",
                ),
        }),
        execute: async (input) => {
            detected = input;
            return { detected: input };
        },
    });

    const agentConfig = {
        id: "tech-detect",
        systemPrompt: SYSTEM_PROMPT,
        model,
        maxSteps: 10,
        tools: (_heartbeat: () => void) => ({
            read_file: buildReadFileTool(projectRoot),
            glob: buildGlobTool(projectRoot, ignorePatterns),
            grep: buildGrepTool(projectRoot),
            bash: buildBashTool(projectRoot),
            finish: finishTool,
        }),
        onStepFinish,
    };

    p.log.info(
        "First, we need to know your backend stack so we can point you to the right SDK adapter and give you correct code examples.",
    );

    await runAgent(
        agentConfig,
        "Detect the backend programming language and web framework for this project. Check dependency files and imports. Call finish with your findings.",
        () => detected,
    );
    logger.summary();

    const suggested = detected ? findAdapter(detected.language, detected.framework) : undefined;

    if (nonInteractive && suggested) return suggested;

    if (!suggested) {
        p.log.warn(
            `Could not auto-detect an exact adapter for your backend.\n` +
                `  If your framework uses the Web Standard Request/Response API (Next.js, Remix, Bun, etc.), choose "Web Standard".\n` +
                `  You can also implement a custom adapter - see ${DOCS_BASE}/sdk/custom-adapter`,
        );
    }

    const options = ALL_ADAPTERS.map((a) => ({
        value: adapterKey(a),
        label: a === suggested ? `${adapterLabel(a)} (detected)` : adapterLabel(a),
        hint: ADAPTER_HINTS[adapterKey(a)] ?? a.adapterPackage,
    }));

    if (suggested) {
        const suggestedIdx = options.findIndex((o) => o.value === adapterKey(suggested));
        if (suggestedIdx > 0) {
            const [item] = options.splice(suggestedIdx, 1);
            options.unshift(item!);
        }
    }

    const selectMessage = detected
        ? `Select your backend adapter (we detected ${detected.language}/${detected.framework}):`
        : "Select your backend adapter:";

    const selected = await p.select({
        message: selectMessage,
        options,
    });

    if (p.isCancel(selected)) {
        throw new Error("Tech detection cancelled");
    }

    const [lang, fw] = selected.split(":");
    const adapter = findAdapter(lang!, fw!);
    if (!adapter) throw new Error(`Unknown adapter: ${selected}`);

    p.log.success(`Using ${adapterLabel(adapter)} - SDK: ${adapter.sdkPackage}, Adapter: ${adapter.adapterPackage}`);

    return adapter;
}
