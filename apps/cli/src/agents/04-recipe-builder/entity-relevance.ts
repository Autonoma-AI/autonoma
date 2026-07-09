import { type LanguageModel, Output, generateText } from "ai";
import { z } from "zod";
import { formatException } from "../../core/errors";
import { AI_MAX_RETRIES } from "../../core/model";
import type { AuditedModel } from "./entity-order";

const rankedSchema = z.object({
    ranked: z.array(z.string()).describe("Every entity name, ordered most-important first."),
});

async function callRanker(model: LanguageModel, prompt: string): Promise<string[]> {
    const result = await generateText({
        model,
        prompt,
        output: Output.object({ schema: rankedSchema }),
        maxRetries: AI_MAX_RETRIES,
    });
    return result.output.ranked;
}

export interface ReconcileResult {
    /** Canonical names in the final, reconciled order. */
    order: string[];
    /** Canonical names the AI omitted (appended to the end in original order). */
    missing: string[];
    /** Names the AI returned that aren't in the canonical set (dropped). */
    invented: string[];
    /** Names the AI returned more than once (later occurrences dropped). */
    duplicates: string[];
}

/**
 * Reconcile an AI-produced ordering against the canonical set of entity names.
 * Pure and deterministic so the validation logic is testable without a model.
 *
 * - Names not in the canonical set are dropped (recorded as `invented`).
 * - Repeated names keep their first occurrence (extras recorded as `duplicates`).
 * - Canonical names the AI omitted are appended at the end in their original
 *   order (recorded as `missing`).
 */
export function reconcileRanking(canonicalInOrder: string[], aiRanked: string[]): ReconcileResult {
    const canonical = new Set(canonicalInOrder);
    const order: string[] = [];
    const seen = new Set<string>();
    const invented: string[] = [];
    const duplicates: string[] = [];

    for (const name of aiRanked) {
        if (!canonical.has(name)) {
            invented.push(name);
            continue;
        }
        if (seen.has(name)) {
            duplicates.push(name);
            continue;
        }
        seen.add(name);
        order.push(name);
    }

    const missing = canonicalInOrder.filter((name) => !seen.has(name));
    order.push(...missing);

    return { order, missing, invented, duplicates };
}

function buildPrompt(auditMarkdown: string, feedback?: string): string {
    return `You are ranking the database entities of an application by how foundational they are, so a user can configure them starting from the ones they understand best.

Rank from MOST important to LEAST important:
- HIGH: entities that many others depend on, and entities representing the primary concepts of the domain - the accounts, users, workspaces/tenants, and core business objects a developer would name first when describing the product.
- LOW: peripheral entities - feature-specific records, integration/audit/logging details, join tables, and narrow or client-specific tables a developer would not have top of mind.

Use the audit below as your only source of truth. The "created_by" relationships and how often an entity owns/spawns others are strong signals of importance.

Return EVERY entity name from the audit, each exactly once, ordered most-important first. Use the names exactly as written in the audit. Do not invent, rename, merge, or omit any entity.${feedback ? `\n\n${feedback}` : ""}

--- ENTITY AUDIT ---
${auditMarkdown}`;
}

/**
 * Ask the model to rank the audited entities by perceived importance and return
 * a `name -> rank index` map (0 = most important) covering every model.
 *
 * Best-effort: on an unrecoverable failure (the call throws, or the result is
 * still broken after one feedback retry) it returns an empty map, signalling the
 * caller to fall back to the default alphabetical ordering. Importance ranking is
 * a UX nicety and must never block recipe building.
 */
export async function rankEntitiesByImportance(
    models: AuditedModel[],
    auditMarkdown: string,
    model: LanguageModel,
): Promise<Map<string, number>> {
    const canonical = models.map((m) => m.name);
    if (canonical.length === 0) return new Map();

    // A result is acceptable if the AI named most entities itself; if it dropped
    // a large fraction we retry once with explicit feedback before giving up.
    const acceptableMissing = Math.floor(canonical.length / 2);

    try {
        let reconciled = reconcileRanking(canonical, await callRanker(model, buildPrompt(auditMarkdown)));

        if (
            reconciled.missing.length > acceptableMissing ||
            reconciled.invented.length > 0 ||
            reconciled.duplicates.length > 0
        ) {
            const feedbackParts: string[] = ["Your previous response had problems. Fix them:"];
            if (reconciled.missing.length > 0)
                feedbackParts.push(`- You omitted these entities, include them: ${reconciled.missing.join(", ")}`);
            if (reconciled.invented.length > 0)
                feedbackParts.push(
                    `- These names are not in the audit, do not use them: ${reconciled.invented.join(", ")}`,
                );
            if (reconciled.duplicates.length > 0)
                feedbackParts.push(
                    `- These were listed more than once, list each exactly once: ${reconciled.duplicates.join(", ")}`,
                );

            const retry = reconcileRanking(
                canonical,
                await callRanker(model, buildPrompt(auditMarkdown, feedbackParts.join("\n"))),
            );
            // Keep the retry only if it's actually better than the first attempt.
            if (retry.missing.length <= reconciled.missing.length) reconciled = retry;
        }

        return new Map(reconciled.order.map((name, i) => [name, i]));
    } catch (err) {
        console.warn(
            `[recipe-builder] Importance ranking failed, falling back to alphabetical order:\n${formatException(err)}`,
        );
        return new Map();
    }
}
