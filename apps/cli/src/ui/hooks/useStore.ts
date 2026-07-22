import { useSyncExternalStore } from "react";
import type { RunStore } from "../store";
import type { RunState } from "../types";

/** Subscribe an Ink component tree to the run store. */
export function useStore(store: RunStore): RunState {
    return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
