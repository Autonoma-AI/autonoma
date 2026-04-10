export function levenshteinDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;

    const dp: number[][] = Array.from({ length: m + 1 }, () => Array.from({ length: n + 1 }, () => 0));

    for (let i = 0; i <= m; i++) dp[i]![0] = i;
    for (let j = 0; j <= n; j++) dp[0]![j] = j;

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
        }
    }

    return dp[m]![n]!;
}

export function suggestSimilarSlugs(input: string, validSlugs: string[], maxSuggestions = 3): string[] {
    const maxDistance = Math.max(Math.floor(input.length / 2), 3);

    return validSlugs
        .map((slug) => ({ slug, distance: levenshteinDistance(input.toLowerCase(), slug.toLowerCase()) }))
        .filter((entry) => entry.distance <= maxDistance)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, maxSuggestions)
        .map((entry) => entry.slug);
}

export function formatSlugNotFoundError(invalidSlugs: string[], validSlugs: string[]): string {
    const lines: string[] = [];

    for (const slug of invalidSlugs) {
        const suggestions = suggestSimilarSlugs(slug, validSlugs);
        if (suggestions.length > 0) {
            lines.push(`Slug "${slug}" not found. Did you mean: ${suggestions.map((s) => `"${s}"`).join(", ")}?`);
        } else {
            lines.push(`Slug "${slug}" not found. No similar slugs found.`);
        }
    }

    lines.push(
        "\nSlugs are plain identifiers (e.g. `login-flow`, `checkout-page-validation`). " +
            "Do NOT use file paths, filenames, or add `.md` extensions. " +
            "Use the exact slug values from the Existing Tests section.",
    );

    if (validSlugs.length <= 20) {
        lines.push(`\nAll valid slugs: ${validSlugs.map((s) => `"${s}"`).join(", ")}`);
    }

    return lines.join("\n");
}
