/**
 * Keys we used to write to `localStorage` and no longer read.
 *
 * A removed feature leaves its key behind on every browser that ever used it, and nothing else will ever clear
 * it - so the browser keeps a preference for a control that does not exist. Retiring a key means adding it
 * here, not just deleting the code that wrote it.
 *
 * `autonoma:sidebar-collapsed` held whether the left navigation rail was narrowed. The rail was replaced by a
 * top bar, which costs no horizontal width, so there is nothing left to collapse.
 */
const RETIRED_STORAGE_KEYS: ReadonlySet<string> = new Set(["autonoma:sidebar-collapsed"]);

/** Best-effort and idempotent: called once at startup, and a browser that blocks storage simply keeps its key. */
export function evictRetiredStorageKeys(): void {
    for (const key of RETIRED_STORAGE_KEYS) {
        try {
            localStorage.removeItem(key);
        } catch (err) {
            console.debug("Failed to evict a retired localStorage key", key, err);
        }
    }
}
