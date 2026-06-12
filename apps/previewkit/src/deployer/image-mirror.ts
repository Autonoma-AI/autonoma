// Hostnames Docker treats as "the default registry". References carrying one
// of these are Docker Hub pulls just like bare references.
const DOCKER_HUB_HOSTS = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"]);

/**
 * Rewrites a Docker Hub image reference to pull through a registry mirror
 * (the ECR pull-through cache in production), so platform-managed workloads
 * never hit Docker Hub rate limits.
 *
 * - `postgres:16` -> `{mirror}/library/postgres:16` (official images live
 *   under the `library/` namespace upstream, which the cache path requires)
 * - `valkey/valkey:8` -> `{mirror}/valkey/valkey:8`
 * - `docker.io/redis:7` -> `{mirror}/library/redis:7`
 * - `ghcr.io/foo/bar:1`, `123.dkr.ecr...`, `localhost:5000/x` -> unchanged
 *   (only Docker Hub references are mirrored)
 *
 * Tags and digests are preserved as-is. An empty `mirrorUrl` disables
 * mirroring and returns the reference unchanged.
 */
export function mirrorDockerHubImage(image: string, mirrorUrl: string): string {
    if (mirrorUrl === "") return image;

    // Per Docker's reference grammar, the first path segment is a registry
    // host only when it contains a "." or ":" or is exactly "localhost";
    // otherwise the whole reference is a Docker Hub repository.
    const slashIndex = image.indexOf("/");
    const firstSegment = slashIndex === -1 ? "" : image.slice(0, slashIndex);
    const hasRegistryHost = firstSegment.includes(".") || firstSegment.includes(":") || firstSegment === "localhost";

    const isForeignRegistry = hasRegistryHost && !DOCKER_HUB_HOSTS.has(firstSegment);
    if (isForeignRegistry) return image;

    const repository = hasRegistryHost ? image.slice(slashIndex + 1) : image;
    const namespacedRepository = repository.includes("/") ? repository : `library/${repository}`;
    return `${mirrorUrl}/${namespacedRepository}`;
}
