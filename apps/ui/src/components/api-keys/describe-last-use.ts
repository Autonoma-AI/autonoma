const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Past this, an exact date reads better than a day count. */
const DAYS_CONSIDERED_RECENT = 30;

/**
 * How recently a key was actually used, which is the signal for whether deleting it will break
 * something right now. "Never used" is the safe case and says so plainly rather than leaving the
 * line blank.
 */
export function describeLastUse(lastRequest: Date | null): string {
    if (lastRequest == null) return "Never used";

    const days = Math.floor((Date.now() - new Date(lastRequest).getTime()) / MS_PER_DAY);
    if (days <= 0) return "Last used today";
    if (days === 1) return "Last used yesterday";
    if (days < DAYS_CONSIDERED_RECENT) return `Last used ${days} days ago`;
    return `Last used ${new Date(lastRequest).toLocaleDateString()}`;
}
