import { createHash } from "node:crypto";
import { logger as rootLogger } from "../logger";

/**
 * All preview images live in a single ECR repository so that one lifecycle
 * policy governs every preview environment. The org/repo/app identity that
 * historically lived in the repository name (`{org}/{repo}:{app}-pr-...`) is
 * folded into the tag instead.
 *
 * The catch: a Docker/OCI tag is capped at 128 characters (the
 * distribution/reference grammar `[\w][\w.-]{0,127}`, enforced by buildctl on
 * push), whereas a repository name has a 255-character budget. App names are
 * user-defined and effectively unbounded, so we cap the readable slug and
 * append a short hash of the full identity. The hash guarantees both length
 * (the tag can never exceed the cap) and uniqueness (short SHAs and PR numbers
 * are not unique across repos, so a discriminator is required for correctness,
 * not just readability).
 */
const PREVIEW_IMAGE_REPOSITORY = "previewkit/previews";

/**
 * Upper bound on the human-readable `{org}-{repo}-{app}` portion of the tag.
 * With the 8-char hash, `-pr-`, a generous PR number, and the 7-char short SHA,
 * the assembled tag stays comfortably under the 128-char Docker tag limit.
 */
const MAX_READABLE_SLUG = 80;

export interface PreviewImageReferenceInput {
    /** Registry host (ECR or the in-cluster registry), without trailing slash. */
    registry: string;
    /** Lowercased GitHub owner/org. */
    org: string;
    /** Lowercased GitHub repository name. */
    repo: string;
    /** App name from `.preview.yaml`. */
    appName: string;
    prNumber: number;
    /** 7-char short commit SHA. */
    shortSha: string;
}

export function buildPreviewImageReference(input: PreviewImageReferenceInput): string {
    const logger = rootLogger.child({ name: "buildPreviewImageReference" });
    const { registry, org, repo, appName, prNumber, shortSha } = input;

    const identity = `${org}/${repo}/${appName}`;
    const discriminator = createHash("sha256").update(identity).digest("hex").slice(0, 8);
    const slug = truncateTagSegment(sanitizeTagSegment(`${org}-${repo}-${appName}`), MAX_READABLE_SLUG);

    const tag = `${slug}-${discriminator}-pr-${prNumber}-${shortSha}`;
    const reference = `${registry}/${PREVIEW_IMAGE_REPOSITORY}:${tag}`;

    logger.debug("Built preview image reference", { extra: { identity, reference, tagLength: tag.length } });
    return reference;
}

/**
 * Lowercases and replaces anything outside the Docker tag character set
 * (`[A-Za-z0-9._-]`) with a hyphen, collapses hyphen runs, and strips leading
 * separators so the tag always begins with a word character as the grammar
 * requires.
 */
function sanitizeTagSegment(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^[-._]+/, "");
}

/** Truncates to `max` chars and trims a trailing separator left by the cut. */
function truncateTagSegment(value: string, max: number): string {
    return value.slice(0, max).replace(/[-._]+$/, "");
}
