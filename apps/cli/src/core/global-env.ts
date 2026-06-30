import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ENV_KEYS } from "../env";

const AUTONOMA_HOME = join(homedir(), ".autonoma");
const GLOBAL_ENV_PATH = join(AUTONOMA_HOME, ".env");

function parseEnvContent(content: string): Record<string, string> {
    const out: Record<string, string> = {};
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
        out[key] = value;
    }
    return out;
}

/**
 * Load `~/.autonoma/.env` into process.env as a fallback. Existing process.env
 * values (real shell env, project .env loaded earlier) always win.
 */
export function loadGlobalEnv(): void {
    let content: string;
    try {
        content = readFileSync(GLOBAL_ENV_PATH, "utf-8");
    } catch {
        return;
    }
    for (const [key, value] of Object.entries(parseEnvContent(content))) {
        if (ENV_KEYS.includes(key) && !(key in process.env)) {
            process.env[key] = value;
        }
    }
}
