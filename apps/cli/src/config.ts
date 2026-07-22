import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadGlobalEnv } from "./core/global-env";
import { ENV_KEYS, readEnv } from "./env";

export interface AppConfig {
    projectRoot: string;
    projectSlug: string;
    modelId?: string;
    // Pre-supplied project-map selection (skips the interactive frontend/backend
    // picker): the single frontend to test and the backends it needs. Used by CI,
    // the eval harness, and any caller that already knows the target surface.
    frontend?: string;
    backends?: string[];
    databaseUrl?: string;
    sharedSecret?: string;
    signingSecret?: string;
    autonomaApiUrl?: string;
    autonomaApiToken?: string;
    autonomaGenerationId?: string;
    // Step-04 handoff presets. `agent` picks the interactive agent (e.g. "claude");
    // `permissionMode` presets its autonomy. Both come from CLI flags.
    agent?: string;
    permissionMode?: string;
}

function loadProjectEnv(projectRoot: string): void {
    let content: string;
    try {
        content = readFileSync(join(projectRoot, ".env"), "utf-8");
    } catch {
        return;
    }

    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        // Only inject keys the CLI actually reads - never arbitrary project keys
        // (PATH, NODE_OPTIONS, ...) that happen to be in the target project's .env.
        if (ENV_KEYS.includes(key) && !(key in process.env)) {
            process.env[key] = value;
        }
    }
}

export function loadConfig(args: {
    project?: string;
    model?: string;
    slug?: string;
    frontend?: string;
    backends?: string[];
    agent?: string;
    permissionMode?: string;
}): AppConfig {
    const projectRoot = resolve(args.project ?? process.cwd());

    // Precedence: real shell env > project .env > global ~/.autonoma/.env.
    // Each loader only sets a key if it isn't already present, so loading the
    // project env first lets it win over the global fallback.
    loadProjectEnv(projectRoot);
    loadGlobalEnv();

    // Read AFTER the loaders so the validated env reflects the project/global
    // .env files just merged into process.env.
    const env = readEnv();

    const projectSlug =
        args.slug ??
        projectRoot
            .split("/")
            .pop()
            ?.toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") ??
        "default";

    return {
        projectRoot,
        projectSlug,
        modelId: args.model ?? env.OPENROUTER_MODEL,
        frontend: args.frontend,
        backends: args.backends,
        databaseUrl: env.DATABASE_URL,
        sharedSecret: env.AUTONOMA_SHARED_SECRET,
        signingSecret: env.AUTONOMA_SIGNING_SECRET,
        // Endpoint the CLI talks to. Defaults to production; override with
        // AUTONOMA_API_URL to point at an alpha/preview host (alpha-<sha>.autonoma.app, ...).
        autonomaApiUrl: env.AUTONOMA_API_URL ?? "https://autonoma.app",
        autonomaApiToken: env.AUTONOMA_API_TOKEN,
        autonomaGenerationId: env.AUTONOMA_GENERATION_ID,
        agent: args.agent,
        permissionMode: args.permissionMode,
    };
}
