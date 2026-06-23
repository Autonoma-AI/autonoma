import type { PreviewConfig } from "../config/schema";

/**
 * Records each deployed dependency's resolved commit SHA onto its matching
 * `config.multirepo.repos` entry (keyed by dependency name), so the persisted
 * `resolvedConfig` carries the exact per-dependency commit state that was live.
 *
 * `shaByDepName` holds only the dependencies that actually deployed; a declared
 * dependency that was skipped (no active revision / no resolvable branch) has no
 * entry and its repo config is returned unchanged. Returns the config untouched
 * when no multirepo block is present.
 */
export function enrichDependencyShas(
    config: PreviewConfig["config"],
    shaByDepName: Map<string, string>,
): PreviewConfig["config"] {
    const multirepo = config?.multirepo;
    if (multirepo == null) return config;

    const repos = multirepo.repos.map((repo) => {
        const sha = shaByDepName.get(repo.name);
        if (sha == null) return repo;
        return { ...repo, sha };
    });
    return { ...config, multirepo: { ...multirepo, repos } };
}
