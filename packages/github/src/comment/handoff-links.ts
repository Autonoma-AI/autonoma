/**
 * The coding-agent handoff's URL plumbing lives in `@autonoma/types` so the in-app failure notes
 * can build the same deep-links the comments do - `apps/ui` cannot depend on this package. Kept as
 * a re-export so the comment builders keep importing it from where the rest of the comment code is.
 */
export {
    type AgentHandoffLink,
    MAX_HANDOFF_PROMPT_CHARS,
    buildAgentHandoffLinks,
    capHandoffPrompt,
} from "@autonoma/types";
