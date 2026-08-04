import { BadRequestError } from "@autonoma/errors";
import { z } from "zod";
import type { McpTargetInput } from "./resolve-mcp-target";

/**
 * The tool fields that name an application, accepting either form.
 *
 * Both are optional in the schema because MCP tool inputs are a flat object, not a union -
 * there is no way to express "exactly one of these" in the shape itself. {@link toTargetInput}
 * enforces it at the call, which also lets the error say what to send instead of failing
 * validation with a message an agent cannot act on.
 */
export const targetInputFields = {
    applicationId: z
        .string()
        .min(1)
        .optional()
        .describe("The application's id, from `pair` during onboarding. Use this or repoFullName, not both."),
    repoFullName: z
        .string()
        .regex(/^[^/]+\/[^/]+$/, "must be 'owner/repo'")
        .optional()
        .describe("The repository as 'owner/repo'. Use this or applicationId, not both."),
};

export interface TargetInputFields {
    applicationId?: string;
    repoFullName?: string;
}

/**
 * Narrow the two optional fields to the one target the tool acts on.
 *
 * Rejects both-or-neither rather than picking a winner: an agent that sends both has two
 * different applications in mind somewhere in its context, and silently preferring one would
 * act on the wrong app without telling anyone.
 */
export function toTargetInput({ applicationId, repoFullName }: TargetInputFields): McpTargetInput {
    if (applicationId != null && repoFullName != null) {
        throw new BadRequestError(
            "Send either applicationId or repoFullName, not both - they may name different applications.",
        );
    }
    if (applicationId != null) return { applicationId };
    if (repoFullName != null) return { repoFullName };
    throw new BadRequestError(
        "Name the application: pass repoFullName ('owner/repo'), or applicationId if you paired during onboarding.",
    );
}
