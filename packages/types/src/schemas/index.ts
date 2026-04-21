import { z } from "zod";

export const PlatformSchema = z.enum(["web", "ios", "android"]);
export type Platform = z.infer<typeof PlatformSchema>;

export const TestStatusSchema = z.enum(["pending", "running", "passed", "failed", "cancelled"]);
export type TestStatus = z.infer<typeof TestStatusSchema>;

export * from "./scenarios";
export * from "./onboarding";
export * from "./review-verdict";
export * from "./generation";
export * from "./api-key";
export * from "./secrets";
