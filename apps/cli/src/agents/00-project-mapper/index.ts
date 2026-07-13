import { tool } from "ai";
import { buildDefaultStepLogger, runAgent } from "../../core/agent";
import { getModel } from "../../core/model";
import { type ProjectMap, ProjectMapSchema } from "../../core/project-map";
import { buildCodebaseTools } from "../../tools";

export interface ProjectMapperInput {
    projectRoot: string;
    modelId?: string;
    outputDir: string;
    nonInteractive?: boolean;
}

const MAX_STEPS = 60;

const SYSTEM_PROMPT =
    "You map a codebase into three groups so the rest of the test-planning pipeline knows exactly what to look at " +
    "and what to skip: FRONTENDS (the UI surfaces whose pages and flows could be tested), BACKENDS (the API/service " +
    "and the data layer that owns the database models we would seed test data into), and IGNORE (everything " +
    "irrelevant to testing this product).\n\n" +
    "You are a DISCOVERY step, not a decision step. The pipeline tests ONE frontend at a time, but YOU do not choose " +
    "which - a human (or the agent driving you) picks afterward from what you found. So enumerate EVERY candidate " +
    "frontend and EVERY candidate backend you can justify; do not prune down to a single app. Pruning happens at " +
    "selection, using the dependency edges you record.\n\n" +
    "Discover the structure - never assume it. Read package/dependency manifests, config files, and the directory " +
    "layout, then reason from evidence:\n" +
    "- A FRONTEND renders a user interface (pages/routes/views, a UI framework or bundler, browser entry points).\n" +
    "- A BACKEND serves an API and/or owns the data layer (a database schema, ORM models, migrations, server routes).\n" +
    "- IGNORE is the rest: infra, build tooling, examples, generated code, and packages that are neither a UI nor a " +
    "service/data-layer.\n\n" +
    "For EACH frontend, record `dependsOn`: the repo-relative paths (each must be one of the backends you list) that " +
    "that frontend actually needs in order to work - the API/service(s) it calls and the data layer(s) that own the " +
    "records it renders. Infer these from evidence: the frontend's dependency manifest, the API clients/SDKs it " +
    "imports, GraphQL/REST endpoints or gateway URLs it points at, and shared data-layer packages it reads. When the " +
    "user selects that frontend, its `dependsOn` backends are pre-checked, so be accurate: list the backends it truly " +
    "needs, not every backend in the repo.\n\n" +
    "Handle every shape without special-casing any framework:\n" +
    "- A single fullstack app can be BOTH a frontend and a backend at the SAME path - list that path under both, and " +
    "put its own path in its `dependsOn`.\n" +
    "- A monorepo can hold many apps and packages - list every genuine frontend and backend; only truly irrelevant " +
    "directories go in IGNORE.\n" +
    "- There may be MANY backends (a main API, separate services, a shared data-layer package, a gateway plus the " +
    "services behind it) - list each one, and wire each frontend's `dependsOn` to just the ones it uses.\n" +
    "- The data layer a frontend uses may live in a sibling/shared package OUTSIDE the frontend's own folder - record " +
    "that package as a backend, point its dataLayer.schemaPath at the schema, and include it in the frontend's " +
    "`dependsOn`.\n" +
    "- A codebase may ship only one half. If you find frontends but NO backend/data layer (or vice versa), still " +
    "record what you found and leave the other group empty - the caller will ask the user to supply the missing half.\n\n" +
    "Be thorough and evidence-based. When you have enumerated the candidates and their dependency edges, call " +
    "set_project_map, then call finish. Keep each `why` to a single concrete sentence citing what you saw.";

/**
 * Run the project-mapper agent: discover and propose the frontend/backend/ignore
 * partition of the codebase. Returns the captured map, or undefined if the agent
 * never produced one. Persistence and user/Claude confirmation happen in the caller.
 */
export async function runProjectMapper(input: ProjectMapperInput): Promise<ProjectMap | undefined> {
    const model = getModel(input.modelId);
    const { logger, onStepFinish } = buildDefaultStepLogger("project-map", MAX_STEPS);

    let captured: ProjectMap | undefined;

    const prompt =
        `Map the codebase rooted at ${input.projectRoot}.\n\n` +
        "Explore the layout and dependency manifests, then enumerate EVERY candidate frontend and EVERY candidate " +
        "backend/data-layer, and for each frontend record the backends it depends on. List everything genuinely " +
        "irrelevant under ignore. Do not prune to a single app - a human picks the one to test afterward. Then call " +
        "set_project_map and finish.";

    const agentConfig = {
        id: "project-mapper",
        systemPrompt: SYSTEM_PROMPT,
        model,
        maxSteps: MAX_STEPS,
        tools: async (heartbeat: () => void) => {
            const tools = await buildCodebaseTools(model, input.projectRoot, input.outputDir, heartbeat);
            return {
                ...tools,
                set_project_map: tool({
                    description:
                        "Record the final project map: the frontend app(s), the backend(s)/data layer(s), and the " +
                        "directories to ignore. Call this once you are confident in the partition, then call finish.",
                    inputSchema: ProjectMapSchema,
                    execute: (map) => {
                        captured = map;
                        return (
                            `Recorded: ${map.frontends.length} frontend(s), ${map.backends.length} backend(s), ` +
                            `${map.ignore.length} ignored. Now call finish.`
                        );
                    },
                }),
            };
        },
        onStepFinish,
    };

    await runAgent(agentConfig, prompt, () => captured);
    logger.summary();

    return captured;
}
