/** Format a duration in milliseconds as a parsed, human-readable string ("1h 2m 3s", "29m 11s", "5s", "200ms"). */
export function formatDuration(ms: number | null | undefined): string {
    if (ms == null) return "-";
    if (ms < 1000) return `${ms}ms`;

    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const parts: string[] = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

    return parts.join(" ");
}

/** Format a cost stored as microdollars (1,000,000ths of a dollar) as a USD string. */
export function formatMicrodollars(microdollars: number): string {
    const dollars = microdollars / 1_000_000;
    return dollars.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 });
}

/** Format a date to a human-readable string. */
export function formatDate(date: Date) {
    return date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

/** Format a date as a short relative time ("2m ago", "3h ago", "5d ago"). Falls back to a locale date for older values. */
export function formatRelativeTime(date: Date): string {
    const diffMs = Date.now() - date.getTime();
    const diffSeconds = Math.floor(diffMs / 1000);
    const diffMinutes = Math.floor(diffSeconds / 60);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);
    if (diffSeconds < 60) return "just now";
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 30) return `${diffDays}d ago`;
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
