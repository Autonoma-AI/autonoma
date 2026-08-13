import { logger as rootLogger } from "@autonoma/logger";
import { readPrDiffStat } from "../pr-range";
import type { RepoCheckout, RepoManifest } from "./manifest";

/**
 * Renders the multi-repo layout for an agent prompt: the primary repo plus every
 * dependency checked out beside it, and the dependencies that could not be. The
 * agent's `bash` working directory is the workspace parent, so every repo is
 * reachable by the relative directory shown here. Each available dependency's
 * changed-files `--stat` is inlined (the same shape-of-change signal the primary
 * gets); the agent pulls the actual patch on demand with `git -C <dir> diff`.
 *
 * Emitted only when a snapshot pinned resolvable dependencies - a plain
 * single-repo checkout has no manifest and the prompt is unchanged.
 */
export async function buildRepoManifestSection(manifest: RepoManifest): Promise<string> {
    const primary = manifest.primary;
    const primaryDiff =
        primary.baseSha != null
            ? ` Diff it with \`git -C ${primary.relPath} diff ${primary.baseSha}..${primary.headSha}\` (the "Code Change" above).`
            : "";
    const lines = [
        "You are grounding across multiple repositories, each checked out as a sibling directory under your `bash` " +
            "working directory (which is the parent, **not** any single repo). Address every repo by the directory " +
            "shown below - including the primary one: `git -C <dir> ...`, `cat <dir>/path`, `rg <pattern> <dir>`. " +
            "When you cite a file, set the reference's `repo` to the repo **name** below; omit it (the default is " +
            "the primary) when citing the primary repo.",
        "",
        `- **${primary.name}** (primary, directory \`${primary.relPath}\`) - the application's own repo and the ` +
            `default for a \`repo\` reference.${primaryDiff}`,
    ];

    for (const dependency of manifest.dependencies) {
        lines.push(await renderDependency(dependency));
    }

    if (manifest.unavailable.length > 0) {
        const names = manifest.unavailable.map((repo) => `${repo.name} (${repo.reason})`).join(", ");
        lines.push(
            "",
            `**Repositories not available for inspection:** ${names}. You cannot read their code; if a failure's ` +
                "only plausible cause lives there, ground only against present code rather than guessing.",
        );
    }

    return lines.join("\n");
}

async function renderDependency(dependency: RepoCheckout): Promise<string> {
    const head = `- **${dependency.name}** (dependency, directory \`${dependency.relPath}\`) - deployed at \`${dependency.headSha}\`.`;

    if (dependency.baseSha == null) {
        return (
            `${head} No previous pinned commit, so this repo is **read-only** (no diff); inspect its current state ` +
            `with \`git -C ${dependency.relPath} show\`, \`cat\`, or \`rg\`.`
        );
    }

    const range = `${dependency.baseSha}..${dependency.headSha}`;
    const pull = `Pull the patch with \`git -C ${dependency.relPath} diff ${range} -- <files>\`.`;
    const stat = await diffStat(dependency, range);
    if (stat == null) {
        return `${head} Changed since the previous reviewed snapshot (\`git -C ${dependency.relPath} diff ${range} --stat\`). ${pull}`;
    }
    return `${head} Changed since the previous reviewed snapshot:\n\`\`\`\n${stat}\n\`\`\`\n${pull}`;
}

/** Best-effort `--stat` for a dependency's diff; a git failure drops the inline stat rather than the section. */
async function diffStat(dependency: RepoCheckout, range: string): Promise<string | undefined> {
    if (dependency.baseSha == null) return undefined;
    try {
        const stat = (
            await readPrDiffStat({ root: dependency.dir, baseSha: dependency.baseSha, headSha: dependency.headSha })
        ).trim();
        return stat.length > 0 ? stat : undefined;
    } catch (error) {
        rootLogger.warn("Failed to read dependency diff stat for the manifest", {
            name: "buildRepoManifestSection",
            extra: { repo: dependency.name, range, error },
        });
        return undefined;
    }
}
