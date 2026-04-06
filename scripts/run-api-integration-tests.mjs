import { spawnSync } from "node:child_process";

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const forwardedArgs = process.argv.slice(2);
const defaultTestFiles = [
    "test/integration/branches.test.ts",
    "test/integration/skills.test.ts",
    "test/integration/scenarios.test.ts",
];
const testFiles = forwardedArgs.length > 0 ? forwardedArgs : defaultTestFiles;

const env = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/autonoma",
    S3_BUCKET: process.env.S3_BUCKET ?? "autonoma-test",
    S3_REGION: process.env.S3_REGION ?? "us-east-1",
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? "test",
    S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? "test",
    API_PORT: process.env.API_PORT ?? "4000",
    SCENARIO_ENCRYPTION_KEY: process.env.SCENARIO_ENCRYPTION_KEY ?? "test-scenario-key",
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? "test-google-client",
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? "test-google-secret",
    GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? "test-gemini-key",
    REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
    TESTING: process.env.TESTING ?? "true",
};

const result = spawnSync(
    pnpmCommand,
    [
        "--filter",
        "@autonoma/api",
        "exec",
        "vitest",
        "run",
        "--config",
        "vitest.integration.config.ts",
        "--passWithNoTests",
        ...testFiles,
    ],
    {
        stdio: "inherit",
        shell: true,
        env,
    },
);

if (result.status == null) {
    process.exit(1);
}

process.exit(result.status);
