import { describe, expect, it } from "vitest";
import { matchPreset, previewkitPresetDefaultVersion, previewkitPresetSpec } from "./previewkit-presets";

describe("matchPreset", () => {
    it("detects a framework from a dependency", () => {
        expect(matchPreset({ dependencies: ["next", "react"], files: [] })).toBe("nextjs");
        expect(matchPreset({ dependencies: ["@sveltejs/kit"], files: [] })).toBe("sveltekit");
        expect(matchPreset({ dependencies: ["nuxt"], files: [] })).toBe("nuxt");
    });

    it("detects a framework from a config file when the dependency is absent", () => {
        expect(matchPreset({ dependencies: [], files: ["next.config.ts"] })).toBe("nextjs");
        expect(matchPreset({ dependencies: [], files: ["astro.config.mjs"] })).toBe("astro");
    });

    it("detects python and ruby from their manifest files", () => {
        expect(matchPreset({ dependencies: [], files: ["pyproject.toml"] })).toBe("python");
        expect(matchPreset({ dependencies: [], files: ["requirements.txt"] })).toBe("python");
        expect(matchPreset({ dependencies: [], files: ["Gemfile"] })).toBe("ruby");
    });

    it("prefers a specific framework over its generic language preset", () => {
        // django/fastapi/rails must win over the generic python/ruby fallbacks.
        expect(matchPreset({ dependencies: ["django"], files: ["manage.py", "requirements.txt"] })).toBe("django");
        expect(matchPreset({ dependencies: [], files: ["manage.py"] })).toBe("django");
        expect(matchPreset({ dependencies: ["fastapi"], files: ["pyproject.toml"] })).toBe("fastapi");
        expect(matchPreset({ dependencies: ["rails"], files: ["Gemfile", "bin/rails"] })).toBe("rails");
        // hono and express are node frameworks, so they must win over the generic node fallback.
        expect(matchPreset({ dependencies: ["hono"], files: ["package.json"] })).toBe("hono");
        expect(matchPreset({ dependencies: ["express"], files: ["package.json"] })).toBe("express");
    });

    it("still falls back to the generic language preset without a framework signal", () => {
        expect(matchPreset({ dependencies: ["flask"], files: ["requirements.txt"] })).toBe("python");
        expect(matchPreset({ dependencies: ["sinatra"], files: ["Gemfile", "config.ru"] })).toBe("ruby");
    });

    it("prefers the more specific framework over the generic node fallback", () => {
        // A Next.js app also carries a package.json (the `node` signal) and often
        // vite as a transitive dev tool; the specific framework must win.
        const preset = matchPreset({
            dependencies: ["next", "vite"],
            files: ["package.json", "next.config.js"],
        });
        expect(preset).toBe("nextjs");
    });

    it("prefers vite over the static index.html fallback", () => {
        expect(matchPreset({ dependencies: ["vite"], files: ["index.html", "package.json"] })).toBe("vite");
    });

    it("falls back to node when only a package.json is present", () => {
        expect(matchPreset({ dependencies: ["lodash"], files: ["package.json"] })).toBe("node");
    });

    it("falls back to static for a bare index.html with no package.json", () => {
        expect(matchPreset({ dependencies: [], files: ["index.html"] })).toBe("static");
    });

    it("returns undefined when nothing matches", () => {
        expect(matchPreset({ dependencies: [], files: ["README.md"] })).toBeUndefined();
    });
});

describe("preset catalog defaults", () => {
    it("builds and serves Next.js on the node toolchain, carrying the whole build tree", () => {
        const spec = previewkitPresetSpec("nextjs");
        expect(spec.toolchain).toBe("node");
        expect(spec.output).toEqual({ mode: "server", copy: "tree" });
        expect(spec.defaultPort).toBe(3000);
        expect(spec.runCommand).toBe("run start");
    });

    it("serves Vite as a static site from dist", () => {
        const spec = previewkitPresetSpec("vite");
        expect(spec.output).toEqual({ mode: "static", dir: "dist" });
        expect(spec.defaultPort).toBe(80);
    });

    it("builds python and ruby presets on their own toolchains as servers", () => {
        const python = previewkitPresetSpec("python");
        expect(python.toolchain).toBe("python");
        expect(python.output).toEqual({ mode: "server", copy: "tree" });

        const ruby = previewkitPresetSpec("ruby");
        expect(ruby.toolchain).toBe("ruby");
        expect(ruby.output).toEqual({ mode: "server", copy: "tree" });
    });

    it("defaults a preset's version from the runtime catalog", () => {
        expect(previewkitPresetDefaultVersion("nextjs")).toBe("22");
        expect(previewkitPresetDefaultVersion("python")).toBe("3.12");
        expect(previewkitPresetDefaultVersion("ruby")).toBe("3.3");
    });

    it("serves the new framework presets on their language toolchains", () => {
        expect(previewkitPresetSpec("hono").toolchain).toBe("node");
        expect(previewkitPresetSpec("express").toolchain).toBe("node");
        // A JS Express API has no build step.
        expect(previewkitPresetSpec("express").buildCommand).toBe("");
        expect(previewkitPresetSpec("express").output).toEqual({ mode: "server", copy: "tree" });
        expect(previewkitPresetSpec("fastapi").toolchain).toBe("python");
        expect(previewkitPresetSpec("fastapi").runCommand).toContain("uvicorn");
        expect(previewkitPresetSpec("django").toolchain).toBe("python");
        expect(previewkitPresetSpec("rails").toolchain).toBe("ruby");
        expect(previewkitPresetSpec("rails").output).toEqual({ mode: "server", copy: "tree" });
    });
});
