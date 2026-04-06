import { describe, expect, it } from "vitest";
import { isTextFile } from "./is-text-file";

describe("isTextFile", () => {
    it("treats Dockerfiles and Makefiles as text", () => {
        expect(isTextFile("Dockerfile")).toBe(true);
        expect(isTextFile("docker/Dockerfile.dev")).toBe(true);
        expect(isTextFile("Makefile")).toBe(true);
    });

    it("treats env files with compound names as text", () => {
        expect(isTextFile(".env")).toBe(true);
        expect(isTextFile(".env.example")).toBe(true);
        expect(isTextFile("apps/api/.env.local")).toBe(true);
    });

    it("keeps extension-based text files working", () => {
        expect(isTextFile("README.md")).toBe(true);
        expect(isTextFile("src/index.ts")).toBe(true);
        expect(isTextFile("pnpm-workspace.yaml")).toBe(true);
    });

    it("ignores binary file types", () => {
        expect(isTextFile("apps/docs/src/assets/favicon.png")).toBe(false);
        expect(isTextFile("packages/diffs/test/fixtures.tar.gz")).toBe(false);
        expect(isTextFile("video.mp4")).toBe(false);
    });
});
