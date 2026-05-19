import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PLAN_AUTHORING_GUIDE = readFileSync(join(import.meta.dirname, "plan-authoring-guide.md"), "utf-8");
