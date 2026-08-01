import type { SecretBundle } from "./secret-cipher";

/**
 * A stable one-line label for a secret bundle, for logs and error messages.
 *
 * Ids only - a bundle names its owner, never a secret key or value, so this is
 * safe to log. Kept in one place because an operator reading a build failure and
 * an operator reading a backfill summary should be looking at the same string.
 */
export function describeSecretBundle(bundle: SecretBundle): string {
    return `app:${bundle.applicationId}/${bundle.appName}`;
}
