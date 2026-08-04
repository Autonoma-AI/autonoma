import type { AuthoredBuild, Build, DeprecatedBuildFramework, PreviewConfig } from "./previewkit-config";
import { type NodeFrameworkBuild, isNodeFrameworkBuild, nodeBuildCommands } from "./previewkit-node-build";

/** The runtime catalog id every node-family preset (node / next / vite) lowers onto. */
const NODE_RUNTIME = "node" as const;

const BUN_HAS_NO_RUNTIME =
    'The bun preset builds from an image the "runtime" catalog does not offer, so there is no equivalent to write ' +
    "down. Commit a Dockerfile for this app and point a dockerfile build at it.";

const ROOT_TURBO_FILTER_UNKNOWN =
    "This app builds from the repository root on the preset's default turbo commands, whose --filter is resolved " +
    "from the repository's workspaces at build time and is not in the document. Set an explicit build_command and " +
    "run_command, then convert it.";

/** The `runtime` arm of the authoring build contract - what every convertible preset becomes. */
type RuntimeBuild = Extract<AuthoredBuild, { framework: "runtime" }>;

/** One app's retired preset rewritten as the `runtime` build the authoring surfaces accept. */
export interface ConvertedBuild {
    app: string;
    from: DeprecatedBuildFramework;
    /** The commands the preset resolved to, now written out verbatim in the runtime block. */
    buildScript?: string;
    entrypoint: string;
}

/** One app whose retired preset has no `runtime` equivalent that can be written down. */
export interface UnconvertibleBuild {
    app: string;
    framework: DeprecatedBuildFramework;
    reason: string;
}

/**
 * A stored document rewritten so every authoring surface accepts it, alongside
 * what had to change.
 *
 * `document` is the input unchanged when nothing was retired, so the common case
 * costs a caller nothing. `unconvertible` is what stops the rewrite being total:
 * those apps keep their stored build block, so the document still cannot be saved
 * until a human decides how that app should build.
 */
export interface AuthorableDocument {
    document: PreviewConfig;
    converted: ConvertedBuild[];
    unconvertible: UnconvertibleBuild[];
}

/**
 * Rewrites a stored preview config into one the authoring surfaces (the dashboard
 * editor, the MCP `apply_config` tools) accept, by expressing each retired
 * framework preset as the `runtime` escape hatch that replaced it.
 *
 * A document saved before the presets were retired reads back with
 * `build.framework: "next"`, which no authoring surface can save - so a caller
 * that reads a document, changes something unrelated and sends it back is
 * rejected over a field it never touched. This produces the send-back-ready
 * equivalent: the same base image and the same install / build / start commands
 * the preset resolves to, written out explicitly. It is the supported
 * equivalent, not a byte-identical image - the runtime path clones to
 * `/workspace/<app>` and installs the common toolbelt.
 *
 * Two shapes have no equivalent that can be written down and are reported in
 * `unconvertible` rather than guessed at: `bun`, which builds from an image the
 * runtime catalog does not offer, and a `root` build context relying on the
 * preset's default turbo commands, whose `--filter` is resolved from the
 * repository's workspaces at build time.
 */
export function toAuthorableDocument(config: PreviewConfig): AuthorableDocument {
    const converted: ConvertedBuild[] = [];
    const unconvertible: UnconvertibleBuild[] = [];

    const apps = config.apps.map((app) => {
        const preset = toRetiredPreset(app.build);
        if (preset == null) return app;

        const outcome = convertPreset(preset);
        if ("reason" in outcome) {
            unconvertible.push({ app: app.name, framework: preset.framework, reason: outcome.reason });
            return app;
        }

        converted.push({
            app: app.name,
            from: preset.framework,
            buildScript: outcome.build.build_script,
            entrypoint: outcome.build.entrypoint,
        });
        return { ...app, build: outcome.build };
    });

    return { document: { ...config, apps }, converted, unconvertible };
}

/** The build block as a retired node-family preset, or undefined when it is already authorable. */
function toRetiredPreset(build: Build | undefined): NodeFrameworkBuild | undefined {
    if (build == null || !isNodeFrameworkBuild(build)) return undefined;
    return build;
}

/** The equivalent `runtime` block, or the reason this preset has none. */
function convertPreset(build: NodeFrameworkBuild): { build: RuntimeBuild } | { reason: string } {
    if (build.framework === "bun") return { reason: BUN_HAS_NO_RUNTIME };

    const needsTurboFilter =
        build.build_context === "root" && (build.build_command == null || build.run_command == null);
    if (needsTurboFilter) return { reason: ROOT_TURBO_FILTER_UNKNOWN };

    const commands = nodeBuildCommands(build);
    const script = [commands.bootstrap, commands.install, commands.build]
        .filter((line): line is string => line != null)
        .join("\n");
    return {
        build: {
            framework: "runtime",
            runtime: NODE_RUNTIME,
            version: build.node_version,
            build_script: script,
            entrypoint: commands.run,
            build_context: build.build_context,
        },
    };
}
