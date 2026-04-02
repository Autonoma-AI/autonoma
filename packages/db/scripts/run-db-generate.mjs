import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/placeholder";
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const result = spawnSync(`${pnpmCommand} run db -- generate`, {
    stdio: "inherit",
    cwd: packageDirectory,
    shell: true,
    env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
    },
});

if (result.status == null) {
    process.exit(1);
}

process.exit(result.status);
