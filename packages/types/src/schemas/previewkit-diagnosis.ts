import { z } from "zod";
import { SuggestedEnvVarSchema } from "./previewkit-env-suggestion";

/** `deployFingerprint` keys the query cache so the diagnosis runs once per failed deploy. */
export const DiagnosePreviewkitDeployInputSchema = z.object({
    applicationId: z.string(),
    deployFingerprint: z.string().optional(),
});

export type DiagnosePreviewkitDeployInput = z.infer<typeof DiagnosePreviewkitDeployInputSchema>;

export const PreviewDiagnosisCategorySchema = z.enum(["missing_env_var", "user_setup", "autonoma_error", "unknown"]);

export type PreviewDiagnosisCategory = z.infer<typeof PreviewDiagnosisCategorySchema>;

export const PreviewDiagnosisActionSchema = z.enum(["edit_config", "edit_secrets", "redeploy", "contact_support"]);

export type PreviewDiagnosisAction = z.infer<typeof PreviewDiagnosisActionSchema>;

export const PreviewDiagnosisFindingSchema = z.object({
    category: PreviewDiagnosisCategorySchema,
    severity: z.enum(["blocking", "warning", "info"]),
    title: z.string(),
    explanation: z.string(),
    fixSteps: z.array(z.string()),
    appName: z.string().optional(),
    fieldPath: z.string().optional(),
    action: PreviewDiagnosisActionSchema.optional(),
    suggestedEnv: z.array(SuggestedEnvVarSchema).optional(),
    confidence: z.enum(["high", "medium", "low"]),
    evidence: z.array(z.string()),
});

export type PreviewDiagnosisFinding = z.infer<typeof PreviewDiagnosisFindingSchema>;

export const DiagnosePreviewkitDeployResultSchema = z.object({
    status: z.enum(["ok", "unavailable"]),
    reason: z.string().optional(),
    summary: z.string().optional(),
    findings: z.array(PreviewDiagnosisFindingSchema),
});

export type DiagnosePreviewkitDeployResult = z.infer<typeof DiagnosePreviewkitDeployResultSchema>;

/** The structured output shape the model is asked to produce; the service adds `status`. */
export const AiDiagnosisResultSchema = z.object({
    summary: z.string(),
    findings: z.array(PreviewDiagnosisFindingSchema),
});

export type AiDiagnosisResult = z.infer<typeof AiDiagnosisResultSchema>;
