import type { Prisma } from "@autonoma/db";

/** Where the planner CLI uploads each artifact. The API's half of a contract the CLI writes against. */
const KB_FILE_PATH = "AUTONOMA.md";
const SCENARIOS_FILE_PATH = "scenarios.md";
const TEST_FILE_PREFIX = "autonoma/qa-tests/";

/** The `data.filePath` key inside an `ApplicationSetupEvent`, as a Prisma JSON path. */
const FILE_PATH_JSON_PATH = ["filePath"];

const FILE_CREATED = "file.created";

/** An artifact an application's setup produces, identified by where its file lands. */
export type ArtifactFile = "kb" | "scenarios" | "tests";

function filePathFilter(artifact: ArtifactFile): Prisma.JsonFilter {
    if (artifact === "kb") return { path: FILE_PATH_JSON_PATH, equals: KB_FILE_PATH };
    if (artifact === "scenarios") return { path: FILE_PATH_JSON_PATH, equals: SCENARIOS_FILE_PATH };
    return { path: FILE_PATH_JSON_PATH, string_starts_with: TEST_FILE_PREFIX };
}

/**
 * The `ApplicationSetupEvent` rows carrying one artifact for an application.
 *
 * Two callers ask whether an artifact landed, and they ask with different queries: the setup checklist
 * counts test files so it can render "3 files", while the Finish setup gate only needs the first row.
 * What must not differ is WHERE they look - so the paths, the JSON filter shape and the event type live
 * here once, and each caller supplies its own `findFirst`/`findMany`. Renaming where the knowledge base
 * lands is then one edit rather than two that can drift apart.
 *
 * Scoped across ALL of the app's setups, never one: an empty or stale setup must not shadow a completed
 * run and blank the checks on refresh.
 */
export function artifactEventWhere(
    applicationId: string,
    artifact: ArtifactFile,
    organizationId?: string,
): Prisma.ApplicationSetupEventWhereInput {
    return {
        setup: { applicationId, organizationId },
        type: FILE_CREATED,
        data: filePathFilter(artifact),
    };
}
