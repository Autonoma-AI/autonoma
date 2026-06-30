import { z } from "zod";
import { ScenarioRecipesFileSchema } from "./scenarios";

export const SetupEventTypeSchema = z.enum([
    "step.started",
    "step.completed",
    "file.read",
    "file.created",
    "log",
    "error",
    "activity",
    "transcript",
]);
export type SetupEventType = z.infer<typeof SetupEventTypeSchema>;

export const SetupStepNames = [
    "Knowledge Base",
    "Entity Audit",
    "Scenarios",
    "Implement",
    "Validate",
    "E2E Tests",
] as const;

export const TOTAL_SETUP_STEPS = SetupStepNames.length;

const StepDataSchema = z.object({
    step: z
        .number()
        .int()
        .min(0)
        .max(TOTAL_SETUP_STEPS - 1),
    name: z.string(),
});

export const FileDataSchema = z.object({
    filePath: z.string(),
});
export type FileData = z.infer<typeof FileDataSchema>;

const MessageDataSchema = z.object({
    message: z.string(),
});

// High-volume agent-activity events emitted by the Claude Code plugin hooks.
// - `activity`: fires once per tool call (PreToolUse hook). Compact — tool name + short preview of the first informative arg.
// - `transcript`: streamed live from the session transcript. Role discriminates between assistant output and tool results.
// These are lossy by design; the plugin truncates text/previews before sending.
const ActivityDataSchema = z.object({
    tool: z.string(),
    preview: z.string().optional(),
});

const TranscriptToolUseSchema = z.object({
    name: z.string(),
    input_preview: z.string().optional(),
});

const TranscriptToolResultSchema = z.object({
    is_error: z.boolean().optional(),
    preview: z.string().optional(),
});

const TranscriptDataSchema = z.object({
    role: z.enum(["assistant", "tool_result"]),
    is_sidechain: z.boolean().optional(),
    uuid: z.string().optional(),
    text: z.string().optional(),
    tool_uses: z.array(TranscriptToolUseSchema).optional(),
    results: z.array(TranscriptToolResultSchema).optional(),
});

export const SetupEventBodySchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("step.started"), data: StepDataSchema }),
    z.object({ type: z.literal("step.completed"), data: StepDataSchema }),
    z.object({ type: z.literal("file.read"), data: FileDataSchema }),
    z.object({ type: z.literal("file.created"), data: FileDataSchema }),
    z.object({ type: z.literal("log"), data: MessageDataSchema }),
    z.object({ type: z.literal("error"), data: MessageDataSchema }),
    z.object({ type: z.literal("activity"), data: ActivityDataSchema }),
    z.object({ type: z.literal("transcript"), data: TranscriptDataSchema }),
]);
export type SetupEventBody = z.infer<typeof SetupEventBodySchema>;

export const CreateSetupBodySchema = z.object({
    applicationId: z.string(),
    repoName: z.string().optional(),
});
export type CreateSetupBody = z.infer<typeof CreateSetupBodySchema>;

export const UpdateSetupBodySchema = z.object({
    name: z.string().optional(),
    status: z.enum(["completed", "partial_failure", "failed"]).optional(),
    errorMessage: z.string().optional(),
});
export type UpdateSetupBody = z.infer<typeof UpdateSetupBodySchema>;

export const SetupStatusSchema = z.enum(["running", "completed", "partial_failure", "failed"]);
export type SetupStatus = z.infer<typeof SetupStatusSchema>;

const UploadFileSchema = z.object({
    name: z.string(),
    content: z.string(),
    folder: z.string().optional(),
});

/**
 * Structured frontmatter carried by an uploaded E2E test-case markdown file,
 * parsed out of each {@link UploadFileSchema} `content` blob during artifact
 * ingestion. Unknown frontmatter keys are ignored.
 */
export const TestCaseFrontmatterSchema = z.object({
    /** Name of the scenario the test runs against; matched against uploaded scenario recipes. */
    scenario: z.string().optional(),
    /** Falsifiable behavioral claim read into the test case's `description`. 20-char floor matches the CLI generator. */
    description: z.string().min(20),
});
export type TestCaseFrontmatter = z.infer<typeof TestCaseFrontmatterSchema>;

export const UploadArtifactsBodySchema = z.object({
    skills: z.array(UploadFileSchema).optional(),
    testCases: z.array(UploadFileSchema).optional(),
    artifacts: z.array(UploadFileSchema).optional(),
    /** The git commit the artifacts were generated from. Stamped onto the resulting snapshot + branch. */
    commitSha: z.string().optional(),
});
export type UploadArtifactsBody = z.infer<typeof UploadArtifactsBodySchema>;

/** Canonical body for `POST /v1/setup/setups/:id/scenario-recipe-versions`. */
export const UploadScenarioRecipeVersionsBodySchema = ScenarioRecipesFileSchema;
export type UploadScenarioRecipeVersionsBody = z.infer<typeof UploadScenarioRecipeVersionsBodySchema>;

/**
 * The set of artifacts the planner CLI uploads at the end of a run. The
 * onboarding "Setup" step polls `applicationSetups.artifactStatus` and checks
 * each one off as it arrives.
 */
export const ArtifactKeySchema = z.enum(["recipe", "tests", "kb", "scenarios"]);
export type ArtifactKey = z.infer<typeof ArtifactKeySchema>;

export const ArtifactStatusItemSchema = z.object({
    key: ArtifactKeySchema,
    received: z.boolean(),
    /** Human-readable detail shown next to the row (e.g. "14 files", "3 scenarios"). */
    meta: z.string().optional(),
});
export type ArtifactStatusItem = z.infer<typeof ArtifactStatusItemSchema>;

/** Response shape for `applicationSetups.artifactStatus`. */
export const ArtifactStatusSchema = z.object({
    /** True once the CLI has finished uploading everything (setup marked completed). */
    complete: z.boolean(),
    artifacts: z.array(ArtifactStatusItemSchema),
});
export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;
