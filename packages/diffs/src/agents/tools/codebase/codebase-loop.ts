import type { AgentLoop } from "@autonoma/ai";
import type { Codebase } from "../../../codebase";

/** Loop that exposes a {@link Codebase} - a handle to the user's repo on disk. */
export interface CodebaseLoop extends AgentLoop {
    readonly codebase: Codebase;
}
