/**
 * Module-level singleton controlling the "sign up to continue" modal, mirroring
 * `toast-manager` so non-component code (the tRPC `MutationCache.onError`) can open it.
 * The modal itself subscribes via `useSyncExternalStore`. There is exactly one modal
 * for the whole app, so a single boolean is enough.
 */
let isOpen = false;
const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of listeners) listener();
}

export const demoModalStore = {
    open(): void {
        if (isOpen) return;
        isOpen = true;
        emit();
    },
    close(): void {
        if (!isOpen) return;
        isOpen = false;
        emit();
    },
    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
    getSnapshot(): boolean {
        return isOpen;
    },
};
