import { type PreviewkitRuntime, previewkitRuntimeSpec } from "./previewkit-runtimes";

/**
 * The framework-preset catalog: Vercel-style, settings-only presets for the split
 * build model. A preset does NOT pick a build image - every app builds in the one
 * uniform builder image, and the built output is copied into a slim per-runtime
 * serve image. A preset only supplies:
 *   - the `toolchain`: which pre-baked language builds the app (and, for `server`
 *     outputs, serves it) - the build stage runs `select-<toolchain> <version>`;
 *   - the default build / run commands (each overridable per app);
 *   - the default port;
 *   - the OUTPUT: what to carry from the builder stage into the slim runtime stage,
 *     served either by a static file server or by the toolchain's slim image.
 *
 * The install command is NOT stored here: it is derived at generation time from the
 * toolchain (node -> the lockfile-detected package manager; python -> uv; ruby ->
 * bundler; ...), so a preset stays a pure framework fact.
 *
 * The runtime VERSION is the only per-project axis and defaults to the runtime
 * catalog's default for the toolchain ({@link previewkitPresetDefaultVersion}),
 * overridable per app.
 *
 * The dashboard reads this catalog to render the preset picker and its defaults;
 * the runner's framework detector reads {@link PreviewkitPresetSpec.detect} to
 * auto-select a preset the way Vercel auto-detects a framework.
 */

export const PREVIEWKIT_PRESET_IDS = [
    "nextjs",
    "nuxt",
    "sveltekit",
    "remix",
    "hono",
    "express",
    "astro",
    "vite",
    "django",
    "fastapi",
    "python",
    "rails",
    "ruby",
    "node",
    "static",
] as const;

export type PreviewkitPreset = (typeof PREVIEWKIT_PRESET_IDS)[number];

/**
 * The detection order for auto-selecting a preset from a repo: specific frameworks
 * first (JS frameworks, then django / fastapi, then rails), then the generic
 * language presets (python, ruby), then generic `node` (any package.json), and
 * `static` (a bare index.html) last. {@link matchPreset} walks this order and
 * returns the first hit, so a Next.js app (which also has a package.json) resolves
 * to `nextjs`, not `node`, and a Django app (which has a Gemfile-free python
 * manifest + manage.py) resolves to `django`, not the generic `python`.
 */
export const PREVIEWKIT_PRESET_DETECTION_ORDER: readonly PreviewkitPreset[] = PREVIEWKIT_PRESET_IDS;

/**
 * What the builder stage produces and how the slim runtime stage serves it.
 * - `static`: copy `dir` (e.g. `dist`) into a minimal static file server (nginx);
 *   no language runtime at serve time - the smallest possible image.
 * - `server`: copy the built app `tree` (or a sub-path) into the toolchain's slim
 *   language image and run the start command (SSR / API / long-running process).
 */
export type PreviewkitOutput = { mode: "static"; dir: string } | { mode: "server"; copy: "tree" | string };

export interface PreviewkitPresetSpec {
    id: PreviewkitPreset;
    /** Display name for the dashboard preset picker, e.g. "Next.js". */
    label: string;
    /**
     * The language that builds the app (from the pre-baked builder toolset), and -
     * for `server` outputs - the slim image that serves it. Its default version
     * comes from the runtime catalog; the app may pin another baked version.
     */
    toolchain: PreviewkitRuntime;
    /**
     * Auto-detection signals. A preset matches when ANY of its `dependencies`
     * appears among the repo's declared packages (package.json deps/devDeps,
     * Gemfile gems, or python packages in pyproject/requirements - whichever the
     * toolchain uses) OR ANY of its `configFiles` is present (an app-root file, or
     * a known nested marker like `bin/rails`). Kept honest and specific so the
     * detection order resolves unambiguously.
     */
    detect: {
        dependencies: readonly string[];
        configFiles: readonly string[];
    };
    /**
     * Default build command, overridable via the app's `build_command`. For node
     * toolchains this is a package-manager script (`run build`) so it works
     * whichever package manager the lockfile selects; the generator prefixes the
     * detected CLI. Empty string means no build step.
     */
    buildCommand: string;
    /**
     * Default start command for `server` outputs, overridable via `run_command`.
     * Ignored for `static` outputs (the static file server serves `output.dir`).
     */
    runCommand: string;
    /** Default container port the served app listens on. */
    defaultPort: number;
    /** What to carry into the slim runtime stage, and how it is served. */
    output: PreviewkitOutput;
}

/** Every `server` preset carries its whole built tree into the slim runtime image. */
const SERVER_TREE: PreviewkitOutput = { mode: "server", copy: "tree" };

export const PREVIEWKIT_PRESET_CATALOG: Record<PreviewkitPreset, PreviewkitPresetSpec> = {
    nextjs: {
        id: "nextjs",
        label: "Next.js",
        toolchain: "node",
        detect: {
            dependencies: ["next"],
            configFiles: ["next.config.js", "next.config.mjs", "next.config.ts"],
        },
        buildCommand: "run build",
        runCommand: "run start",
        defaultPort: 3000,
        // `next start` needs `.next` + node_modules + config, so carry the whole
        // built tree. (Standalone-output slimming is a later optimization.)
        output: SERVER_TREE,
    },
    nuxt: {
        id: "nuxt",
        label: "Nuxt",
        toolchain: "node",
        detect: {
            dependencies: ["nuxt", "nuxt3"],
            configFiles: ["nuxt.config.js", "nuxt.config.ts", "nuxt.config.mjs"],
        },
        buildCommand: "run build",
        // Nuxt 3's default Nitro preset is a self-contained node server under
        // `.output`; run it directly rather than through a package script.
        runCommand: "node .output/server/index.mjs",
        defaultPort: 3000,
        output: SERVER_TREE,
    },
    sveltekit: {
        id: "sveltekit",
        label: "SvelteKit",
        toolchain: "node",
        detect: {
            dependencies: ["@sveltejs/kit"],
            configFiles: ["svelte.config.js"],
        },
        buildCommand: "run build",
        // Assumes adapter-node (the previewkit-supported adapter): it emits a
        // `build/` server started with `node build`. Apps on another adapter must
        // override run_command / output_directory.
        runCommand: "node build",
        defaultPort: 3000,
        output: SERVER_TREE,
    },
    remix: {
        id: "remix",
        label: "Remix",
        toolchain: "node",
        detect: {
            dependencies: ["@remix-run/dev", "@remix-run/node", "@remix-run/serve"],
            configFiles: ["remix.config.js"],
        },
        buildCommand: "run build",
        runCommand: "run start",
        defaultPort: 3000,
        output: SERVER_TREE,
    },
    hono: {
        id: "hono",
        label: "Hono",
        toolchain: "node",
        detect: {
            dependencies: ["hono"],
            configFiles: [],
        },
        buildCommand: "run build",
        runCommand: "run start",
        defaultPort: 3000,
        // Assumes the Node adapter (@hono/node-server). Edge / Workers / Bun
        // deploys build differently and would override the run command.
        output: SERVER_TREE,
    },
    express: {
        id: "express",
        label: "Express",
        toolchain: "node",
        detect: {
            dependencies: ["express"],
            configFiles: [],
        },
        // A plain-JS Express API: the derived dependency install is the only prep, so
        // there is no build step. Assumes a `start` script; an app without one overrides
        // run_command with its entry file (e.g. `node server.js`).
        buildCommand: "",
        runCommand: "run start",
        defaultPort: 3000,
        output: SERVER_TREE,
    },
    astro: {
        id: "astro",
        label: "Astro",
        toolchain: "node",
        detect: {
            dependencies: ["astro"],
            configFiles: ["astro.config.mjs", "astro.config.ts", "astro.config.js"],
        },
        buildCommand: "run build",
        runCommand: "",
        defaultPort: 80,
        // Default Astro output is a static site in `dist`. An SSR Astro app (with a
        // server adapter) must override output to server mode.
        output: { mode: "static", dir: "dist" },
    },
    vite: {
        id: "vite",
        label: "Vite",
        toolchain: "node",
        detect: {
            dependencies: ["vite"],
            configFiles: ["vite.config.js", "vite.config.ts", "vite.config.mjs"],
        },
        buildCommand: "run build",
        runCommand: "",
        defaultPort: 80,
        output: { mode: "static", dir: "dist" },
    },
    django: {
        id: "django",
        label: "Django",
        toolchain: "python",
        detect: {
            dependencies: ["django", "Django"],
            configFiles: ["manage.py"],
        },
        // No build step in dev mode (runserver serves static with DEBUG=True). For
        // production, override build_command with `python manage.py collectstatic --noinput`.
        buildCommand: "",
        runCommand: "python manage.py runserver 0.0.0.0:$PORT",
        defaultPort: 8000,
        output: SERVER_TREE,
    },
    fastapi: {
        id: "fastapi",
        label: "FastAPI",
        toolchain: "python",
        detect: {
            dependencies: ["fastapi"],
            configFiles: [],
        },
        buildCommand: "",
        // Assumes the app object is `main:app`; override for another module path
        // (e.g. `uvicorn app.main:app --host 0.0.0.0 --port $PORT`).
        runCommand: "uvicorn main:app --host 0.0.0.0 --port $PORT",
        defaultPort: 8000,
        output: SERVER_TREE,
    },
    python: {
        id: "python",
        label: "Python",
        toolchain: "python",
        detect: {
            dependencies: [],
            configFiles: ["pyproject.toml", "requirements.txt", "Pipfile"],
        },
        // Dependency install (uv) is derived from the toolchain; most Python web
        // apps have no separate build step.
        buildCommand: "",
        // Generic default - override run_command for your framework (e.g.
        // `python manage.py runserver 0.0.0.0:$PORT`, `uvicorn main:app --port $PORT`).
        runCommand: "python main.py",
        defaultPort: 8000,
        output: SERVER_TREE,
    },
    rails: {
        id: "rails",
        label: "Ruby on Rails",
        toolchain: "ruby",
        detect: {
            dependencies: ["rails"],
            configFiles: ["bin/rails", "config/application.rb"],
        },
        // No build step in development mode (assets compile on the fly). For
        // production, override with `SECRET_KEY_BASE_DUMMY=1 bin/rails assets:precompile`.
        buildCommand: "",
        runCommand: "bin/rails server -b 0.0.0.0 -p $PORT",
        defaultPort: 3000,
        output: SERVER_TREE,
    },
    ruby: {
        id: "ruby",
        label: "Ruby",
        toolchain: "ruby",
        detect: {
            dependencies: [],
            configFiles: ["Gemfile", "config.ru", "Rakefile"],
        },
        // `bundle install` is derived from the toolchain; no separate build step.
        buildCommand: "",
        // Rack default - override for Rails (`bin/rails server -b 0.0.0.0 -p $PORT`).
        runCommand: "bundle exec rackup --host 0.0.0.0 --port $PORT",
        defaultPort: 9292,
        output: SERVER_TREE,
    },
    node: {
        id: "node",
        label: "Node.js",
        toolchain: "node",
        // Fallback for any package.json that matched no specific framework above.
        detect: {
            dependencies: [],
            configFiles: ["package.json"],
        },
        buildCommand: "run build",
        runCommand: "run start",
        defaultPort: 3000,
        output: SERVER_TREE,
    },
    static: {
        id: "static",
        label: "Static",
        toolchain: "node",
        // Last-resort fallback: a plain static site with no build step. The output
        // directory is the most common thing to override.
        detect: {
            dependencies: [],
            configFiles: ["index.html"],
        },
        buildCommand: "",
        runCommand: "",
        defaultPort: 80,
        output: { mode: "static", dir: "." },
    },
};

export const PREVIEWKIT_PRESETS: readonly PreviewkitPresetSpec[] = PREVIEWKIT_PRESET_IDS.map(
    (id) => PREVIEWKIT_PRESET_CATALOG[id],
);

export function previewkitPresetSpec(preset: PreviewkitPreset): PreviewkitPresetSpec {
    return PREVIEWKIT_PRESET_CATALOG[preset];
}

/** The default runtime version a preset builds and serves with (from the runtime catalog). */
export function previewkitPresetDefaultVersion(preset: PreviewkitPreset): string {
    return previewkitRuntimeSpec(PREVIEWKIT_PRESET_CATALOG[preset].toolchain).defaultVersion;
}

/** The repo signals the {@link matchPreset} detector keys off. */
export interface PresetDetectionSignals {
    /**
     * Package names declared across the repo's manifests - npm
     * dependencies/devDependencies, Gemfile gems, and python packages in
     * pyproject/requirements - unioned. The detector collects these; the catalog
     * only names which ones imply which preset.
     */
    dependencies: readonly string[];
    /** Notable files present (app-root files, plus known nested markers like `bin/rails`). */
    files: readonly string[];
}

/**
 * Auto-selects the best preset for a repo from its declared packages + notable
 * files, walking {@link PREVIEWKIT_PRESET_DETECTION_ORDER} (specific frameworks
 * first, then the generic language presets, then generic `node`, then `static`).
 * Returns undefined when nothing matches - the caller decides the fallback. Pure
 * and shared by the dashboard and the runner so both auto-detect identically.
 */
export function matchPreset(signals: PresetDetectionSignals): PreviewkitPreset | undefined {
    const deps = new Set(signals.dependencies);
    const files = new Set(signals.files);
    for (const preset of PREVIEWKIT_PRESET_DETECTION_ORDER) {
        const spec = PREVIEWKIT_PRESET_CATALOG[preset];
        const dependencyHit = spec.detect.dependencies.some((dependency) => deps.has(dependency));
        const configHit = spec.detect.configFiles.some((file) => files.has(file));
        if (dependencyHit || configHit) return preset;
    }
    return undefined;
}
