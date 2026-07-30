import { PreviewSecrets } from "@autonoma/secrets";
import { env } from "./env";

/**
 * The reader behind the preview-introspection tools (`get_preview_env`,
 * `run_script`): the env a repo's preview pods actually run with.
 *
 * Wired from this worker's own env, because `PREVIEWKIT_SECRETS_READ` asserts that
 * the database `DATABASE_URL` points at holds the secrets - it is meaningless apart
 * from that connection.
 */
export function previewSecrets(): PreviewSecrets {
    return PreviewSecrets.create({
        region: env.AWS_REGION,
        read: env.PREVIEWKIT_SECRETS_READ,
        cmk: env.PREVIEWKIT_SECRETS_CMK,
    });
}
