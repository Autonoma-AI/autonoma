import { createHash } from "node:crypto";

/**
 * Who a preview secret belongs to, and how that is proven. Every secret is
 * stamped with `previewkit:*` owner tags at creation:
 *
 *  - Human-readable name tags (`org`, `application`, `app`) for diagnostics.
 *    They pass through {@link awsTagSafe}, which is LOSSY - two distinct names
 *    can produce the same tag value - so ownership never compares on them for
 *    current-era secrets.
 *  - A non-lossy identity pair (`applicationId`, `appNameHash`) that no
 *    transform can alias. This is what {@link isOwnedByCaller} compares.
 *
 * Legacy secrets predate the identity pair; for them the name tags were
 * written raw (AWS accepted them), so the name-tag comparison is exact and
 * remains the fallback.
 */

/** The owner recorded on a secret's `previewkit:*` tags at creation. */
export interface SecretOwner {
    org?: string;
    application?: string;
    app?: string;
    /** Non-lossy identity tags; absent on legacy secrets created before them. */
    applicationId?: string;
    appNameHash?: string;
}

/** The caller's identity for an ownership check, mirroring what {@link ownerTags} stamps. */
export interface SecretOwnerIdentity {
    applicationId: string;
    orgSlug: string;
    applicationName: string;
    appName: string;
}

/**
 * AWS tag values only accept unicode letters/digits/whitespace plus `+ - = . _ : / @`;
 * anything else (a `)` in an application name, say) makes the whole CreateSecret
 * call fail with AWS's opaque "Request rejected by the downstream tagging service".
 */
const AWS_TAG_INVALID_REGEX = /[^\p{L}\p{N}\s+\-=._:/@]+/gu;

/** The owner tags stamped on a secret at creation - the write side of {@link isOwnedByCaller}. */
export function ownerTags(identity: SecretOwnerIdentity): Array<{ Key: string; Value: string }> {
    return [
        // Human-readable, lossy - diagnostics only.
        { Key: "previewkit:org", Value: awsTagSafe(identity.orgSlug) },
        { Key: "previewkit:application", Value: awsTagSafe(identity.applicationName) },
        { Key: "previewkit:app", Value: awsTagSafe(identity.appName) },
        // Non-lossy identity - what isOwnedByCaller actually compares.
        { Key: "previewkit:applicationId", Value: identity.applicationId },
        { Key: "previewkit:appNameHash", Value: appNameHash(identity.appName) },
    ];
}

/** Parses a DescribeSecret tag list back into a {@link SecretOwner}. */
export function describeSecretOwner(tags: Array<{ Key?: string; Value?: string }> | undefined): SecretOwner {
    const byKey = new Map((tags ?? []).map((tag) => [tag.Key, tag.Value]));
    return {
        org: byKey.get("previewkit:org"),
        application: byKey.get("previewkit:application"),
        app: byKey.get("previewkit:app"),
        applicationId: byKey.get("previewkit:applicationId"),
        appNameHash: byKey.get("previewkit:appNameHash"),
    };
}

/**
 * The ownership gate, shared by the adopt path and the save-time preflight so
 * the two can never drift. Secrets carrying the non-lossy identity tags are
 * judged on those alone - the lossy name tags can collide across distinct
 * owners (`Bank:)` and `Bank:(` both tag as `Bank:-`). Legacy secrets fall
 * back to the name tags; `awsTagSafe` is the identity for every tag value AWS
 * ever accepted, so that comparison is unchanged for them.
 */
export function isOwnedByCaller(owner: SecretOwner, caller: SecretOwnerIdentity): boolean {
    if (owner.applicationId != null) {
        return owner.applicationId === caller.applicationId && owner.appNameHash === appNameHash(caller.appName);
    }
    return (
        owner.org === awsTagSafe(caller.orgSlug) &&
        owner.application === awsTagSafe(caller.applicationName) &&
        owner.app === awsTagSafe(caller.appName)
    );
}

/**
 * User-facing explanation of a sanitized-path collision. The owning
 * application is named ONLY when the owner tags place it in the caller's own
 * org (org members can already see those names in the UI - no new exposure);
 * any other owner stays anonymous so the message can never leak a name across
 * an org boundary.
 */
export function collisionMessage(appName: string, owner: SecretOwner, callerOrgSlug: string): string {
    const sameOrg = owner.org === awsTagSafe(callerOrgSlug);
    const ownerLabel =
        sameOrg && owner.application != null
            ? `application "${owner.application}" (app "${owner.app ?? "?"}")`
            : "another application";
    return (
        `The app name "${appName}" collides with the preview secrets of ${ownerLabel} - ` +
        `the two names sanitize to the same secret path. Rename the app (or the application) ` +
        `to something distinct and save again.`
    );
}

function awsTagSafe(value: string): string {
    return value.replace(AWS_TAG_INVALID_REGEX, "-");
}

/**
 * Non-lossy, always-tag-safe encoding of a raw app name (hex SHA-256). The
 * applicationId is inherently tag-safe; the raw app name is not, so it is
 * carried as a hash instead of a transformed - and therefore aliasable - name.
 */
function appNameHash(appName: string): string {
    return createHash("sha256").update(appName, "utf8").digest("hex");
}
