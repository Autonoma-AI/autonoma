import { describe, expect, it } from "vitest";
import { generateDockerfile, type GenerateDockerfileContext } from "../../src/dockerfile-builder/generate-dockerfile";

const ctx: GenerateDockerfileContext = { registryMirror: "", buildArgs: {}, port: 3000, appName: "web" };

describe("generateDockerfile", () => {
    it("generates a node + pnpm app-context Dockerfile with derived defaults", () => {
        const df = generateDockerfile(
            { framework: "node", package_manager: "pnpm", node_version: "22", build_context: "app" },
            ctx,
        );
        expect(df).toContain("FROM node:22-bookworm-slim");
        expect(df).toContain("RUN corepack enable");
        expect(df).toContain("RUN pnpm install --frozen-lockfile");
        expect(df).toContain("RUN pnpm run build");
        expect(df).toContain("ENV PORT=3000");
        expect(df).toContain("EXPOSE 3000");
        expect(df).toContain("CMD pnpm start");
    });

    it("uses the node_version in the base image tag", () => {
        const df = generateDockerfile(
            { framework: "node", package_manager: "pnpm", node_version: "20.11.0", build_context: "app" },
            ctx,
        );
        expect(df).toContain("FROM node:20.11.0-bookworm-slim");
    });

    it("generates a bun Dockerfile with the bun base image and no corepack", () => {
        const df = generateDockerfile({ framework: "bun", build_context: "app" }, ctx);
        expect(df).toContain("FROM oven/bun:1");
        expect(df).not.toContain("corepack");
        expect(df).toContain("RUN bun install");
        expect(df).toContain("RUN bun run build");
        expect(df).toContain("CMD bun start");
    });

    it("uses npm ci (no corepack) for the npm package manager", () => {
        const df = generateDockerfile(
            { framework: "node", package_manager: "npm", node_version: "22", build_context: "app" },
            ctx,
        );
        expect(df).not.toContain("corepack");
        expect(df).toContain("RUN npm ci");
        expect(df).toContain("CMD npm start");
    });

    it("defaults vite's run command to the preview script", () => {
        const df = generateDockerfile(
            { framework: "vite", package_manager: "pnpm", node_version: "22", build_context: "app" },
            ctx,
        );
        expect(df).toContain("CMD pnpm run preview");
    });

    it("uses the resolved turbo filter (real workspace package name) for a root build context", () => {
        const df = generateDockerfile(
            { framework: "next", package_manager: "pnpm", node_version: "22", build_context: "root" },
            { ...ctx, turboFilter: "--filter=@acme/storefront" },
        );
        expect(df).toContain("RUN pnpm exec turbo run build --filter=@acme/storefront");
        expect(df).toContain("CMD pnpm exec turbo run start --filter=@acme/storefront");
        expect(df).not.toContain("--filter=web");
    });

    it("throws for a root build context with no resolved turbo filter (broken caller invariant)", () => {
        expect(() =>
            generateDockerfile(
                { framework: "next", package_manager: "pnpm", node_version: "22", build_context: "root" },
                ctx,
            ),
        ).toThrow(/root build_context requires a resolved turbo --filter/);
    });

    it("rewrites the base image through the registry mirror when set", () => {
        const df = generateDockerfile(
            { framework: "node", package_manager: "pnpm", node_version: "22", build_context: "app" },
            { ...ctx, registryMirror: "123.dkr.ecr.us-east-1.amazonaws.com/docker-hub" },
        );
        expect(df).toContain("FROM 123.dkr.ecr.us-east-1.amazonaws.com/docker-hub/library/node:22-bookworm-slim");
    });

    it("emits ENV lines for build args, quoted", () => {
        const df = generateDockerfile(
            { framework: "vite", package_manager: "pnpm", node_version: "22", build_context: "app" },
            { ...ctx, buildArgs: { VITE_API_URL: "https://example.com", FLAG: 'a"b' } },
        );
        expect(df).toContain('ENV VITE_API_URL="https://example.com"');
        expect(df).toContain('ENV FLAG="a\\"b"');
    });

    it("honors command overrides verbatim", () => {
        const df = generateDockerfile(
            {
                framework: "node",
                package_manager: "pnpm",
                node_version: "22",
                build_context: "app",
                install_command: "pnpm install --offline",
                build_command: "pnpm nx build web",
                run_command: "node dist/main.js",
            },
            ctx,
        );
        expect(df).toContain("RUN pnpm install --offline");
        expect(df).toContain("RUN pnpm nx build web");
        expect(df).toContain("CMD node dist/main.js");
        expect(df).not.toContain("pnpm run build");
    });

    describe("runtime escape hatch", () => {
        it("builds a language runtime from its pinned image with the apt toolbelt and a heredoc build", () => {
            const df = generateDockerfile(
                {
                    framework: "runtime",
                    runtime: "node",
                    build_script: "npm install\nnpm run build",
                    entrypoint: "npm start",
                    build_context: "app",
                },
                ctx,
            );
            // defaults to the catalog's pinned version (node 22).
            expect(df).toContain("FROM node:22-bookworm-slim");
            expect(df).toContain("apt-get install -y --no-install-recommends git curl");
            // node's per-runtime setup enables corepack (pnpm + yarn).
            expect(df).toContain("RUN corepack enable");
            // clones to /workspace/<app>, matching the sandbox reference.
            expect(df).toContain("WORKDIR /workspace/web");
            // the build script + entrypoint run under bash, not the default /bin/sh.
            expect(df).toContain('SHELL ["/bin/bash", "-c"]');
            // multi-line bash survives verbatim inside a heredoc RUN.
            expect(df).toContain("RUN <<'AUTONOMA_BUILD_EOF'");
            expect(df).toContain("npm install\nnpm run build");
            expect(df).toContain("CMD npm start");
        });

        it("honors a user-selected runtime version in the image tag", () => {
            const df = generateDockerfile(
                { framework: "runtime", runtime: "node", version: "20", entrypoint: "npm start", build_context: "app" },
                ctx,
            );
            expect(df).toContain("FROM node:20-bookworm-slim");
        });

        it("builds the bare Debian base image with the apt toolbelt", () => {
            const df = generateDockerfile(
                {
                    framework: "runtime",
                    runtime: "debian",
                    build_script: "apt-get update\napt-get install -y build-essential",
                    entrypoint: "./start.sh",
                    build_context: "app",
                },
                ctx,
            );
            expect(df).toContain("FROM debian:bookworm-slim");
            expect(df).toContain("apt-get install -y --no-install-recommends git curl");
            expect(df).toContain("WORKDIR /workspace/web");
            // debian-slim ships /bin/bash natively, so the SHELL switch is safe.
            expect(df).toContain('SHELL ["/bin/bash", "-c"]');
            expect(df).toContain("CMD ./start.sh");
        });

        it("omits the build step when no build script is given", () => {
            const df = generateDockerfile(
                { framework: "runtime", runtime: "go", entrypoint: "./app", build_context: "app" },
                ctx,
            );
            expect(df).toContain("FROM golang:1.22-bookworm");
            expect(df).not.toContain("AUTONOMA_BUILD_EOF");
            expect(df).toContain("CMD ./app");
        });

        it("emits build-arg ENV lines and mirrors the runtime base image", () => {
            const df = generateDockerfile(
                {
                    framework: "runtime",
                    runtime: "python",
                    build_script: "uv sync",
                    entrypoint: "python main.py",
                    build_context: "app",
                },
                {
                    ...ctx,
                    registryMirror: "123.dkr.ecr.us-east-1.amazonaws.com/docker-hub",
                    buildArgs: { API_URL: "https://x" },
                },
            );
            expect(df).toContain(
                "FROM 123.dkr.ecr.us-east-1.amazonaws.com/docker-hub/library/python:3.12-slim-bookworm",
            );
            expect(df).toContain('ENV API_URL="https://x"');
        });
    });
});
