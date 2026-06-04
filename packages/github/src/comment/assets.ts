export function resolveCommentAssetBaseUrl({
    explicitAssetBaseUrl,
    appUrl,
}: {
    explicitAssetBaseUrl?: string | null;
    appUrl: string;
}): string {
    if (explicitAssetBaseUrl != null && explicitAssetBaseUrl !== "") return explicitAssetBaseUrl;
    return new URL("/github-comment/", appUrl).toString();
}
