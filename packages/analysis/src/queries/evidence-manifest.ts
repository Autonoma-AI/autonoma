import type { Prisma } from "@autonoma/db";
import { type EvidenceManifestEntry, evidenceManifestEntrySchema } from "@autonoma/types";

const manifestSchema = evidenceManifestEntrySchema.array();

/**
 * The assets a stored narrative embeds by token. A missing or malformed blob reads as no evidence: the prose
 * still renders and its tokens resolve to nothing.
 */
export function parseEvidenceManifest(json: Prisma.JsonValue | null): EvidenceManifestEntry[] {
    if (json == null) return [];
    const parsed = manifestSchema.safeParse(json);
    return parsed.success ? parsed.data : [];
}
