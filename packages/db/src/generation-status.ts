import { GenerationStatus } from "./generated/prisma/client";

const TERMINAL_GENERATION_STATUSES: ReadonlySet<GenerationStatus> = new Set([
    GenerationStatus.success,
    GenerationStatus.failed,
]);

/** Shaped for a Prisma `status: { in: ... }` filter; ask {@link isIncompleteGenerationStatus} for membership. */
export const INCOMPLETE_GENERATION_STATUSES: GenerationStatus[] = Object.values(GenerationStatus).filter(
    (status) => !TERMINAL_GENERATION_STATUSES.has(status),
);

export function isIncompleteGenerationStatus(status: GenerationStatus): boolean {
    return !TERMINAL_GENERATION_STATUSES.has(status);
}
