import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The authoritative guide for writing the BODY of a test plan (Setup / Steps / Verification / Expected Result):
 * mandatory mutation + functional verification against the source of truth, allowed/banned verbs, visual-only
 * assertion constraints, i18n resolution, before/after value asserts, state-transition awareness. Single-sourced
 * here because both the diffs agent and the investigation agent author plans and must author them to the same bar.
 */
export const PLAN_AUTHORING_GUIDE = readFileSync(join(import.meta.dirname, "plan-authoring-guide.md"), "utf-8");
