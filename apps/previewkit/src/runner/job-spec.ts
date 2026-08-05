import { type PreviewJobSpec, previewJobSpecSchema } from "@autonoma/types";

export type { PreviewJobSpec };

/**
 * Parses + validates the raw PREVIEWKIT_JOB_SPEC env value. Throws (which the runner surfaces as a non-zero exit)
 * when it is missing or malformed - a misconfigured Job should fail loudly, not silently no-op.
 */
export function parseJobSpec(raw: string | undefined): PreviewJobSpec {
    if (raw == null || raw === "") {
        throw new Error("PREVIEWKIT_JOB_SPEC is required for a preview runner Job but was empty");
    }
    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch (err) {
        throw new Error(`PREVIEWKIT_JOB_SPEC is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    return previewJobSpecSchema.parse(json);
}
