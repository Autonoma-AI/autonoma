import { z } from "zod";

export const PlatformSchema = z.enum(["web", "ios", "android"]);
export type Platform = z.infer<typeof PlatformSchema>;

export const TestStatusSchema = z.enum(["pending", "running", "passed", "failed", "cancelled"]);
export type TestStatus = z.infer<typeof TestStatusSchema>;

export * from "./scenarios";
export * from "./onboarding";
export * from "./suspected-cause";
export * from "./issue-report";
export * from "./generation-verdict";
export * from "./bug-verdict";
export * from "./replay-verdict";
export * from "./generation";
export * from "./api-key";
export * from "./secrets";
export * from "./org-secrets";
export * from "./previewkit-builtins";
export * from "./previewkit-config";
export * from "./previewkit-introspection";
export * from "./previewkit-service-suggestion";
export * from "./previewkit-env-suggestion";
export * from "./previewkit-diagnosis";
export * from "./snapshot-dependency-pin";
export * from "./healing-actions";
export * from "./snapshot-report";
export * from "./checkpoint-summary";
export * from "./bug-detail";
export * from "./investigation-report";
