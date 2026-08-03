import { isSameRepository, type PreviewConfig } from "../config/schema";

/**
 * Records each deployed dependency repo's resolved commit SHA onto its
 * `repositories[]` entry (keyed by repo full name, adding an entry for a repo
 * with no authored overrides), so the persisted `resolvedConfig` carries the
 * exact per-dependency commit state that was live. Multi-repo grounding reads
 * this back to inspect the exact code that was deployed.
 *
 * `shaByRepo` holds only the dependency repos that actually deployed; a repo
 * whose branch never resolved (its apps were skipped) has no entry and its
 * settings are returned unchanged.
 */
export function enrichRepositoryShas(config: PreviewConfig, shaByRepo: Map<string, string>): PreviewConfig {
    if (shaByRepo.size === 0) return config;

    const repositories = config.repositories.map((settings) => {
        const sha = [...shaByRepo.entries()].find(([repo]) => isSameRepository(repo, settings.repo))?.[1];
        if (sha == null) return settings;
        return { ...settings, sha };
    });
    const declared = new Set(config.repositories.map((settings) => settings.repo.toLowerCase()));
    for (const [repo, sha] of shaByRepo) {
        if (declared.has(repo.toLowerCase())) continue;
        repositories.push({ repo, fallback_branch: "main", sha });
    }
    return { ...config, repositories };
}
