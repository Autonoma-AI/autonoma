const BRAND = "Autonoma";
const PR_TITLE_PREFIX = `${BRAND} - `;

/**
 * The unified PR comment's title in the `Autonoma - <state>` form.
 *
 * A settled analysis title already leads with "Autonoma ..." (e.g. "Autonoma found 2 bugs in this PR"); strip that
 * lead before prefixing so the result reads "Autonoma - found 2 bugs in this PR", not a doubled "Autonoma - Autonoma
 * found...". Kept here rather than folded into the shared analysis title helper, so the in-app PR page keeps its own
 * un-prefixed title.
 */
export function toPrCommentTitle(state: string): string {
    const trimmed = state.trim();
    const brandLead = `${BRAND.toLowerCase()} `;
    const body = trimmed.toLowerCase().startsWith(brandLead) ? trimmed.slice(BRAND.length + 1).trimStart() : trimmed;
    return `${PR_TITLE_PREFIX}${body}`;
}
