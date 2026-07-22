import { useInput } from "ink";
import { useCallback, useEffect, useMemo } from "react";
import { interruptPress } from "../core/interrupt";
import { App } from "./App";
import { useStore } from "./hooks/useStore";
import type { RunStore } from "./store";

/**
 * Binds the live run store to the presentational <App> and owns Ctrl+C.
 *
 * Ink is mounted with exitOnCtrlC: false, so Ctrl+C arrives here as raw input.
 * Presses are fed to the shared interrupt policy (double-press to exit); the
 * arm state comes back into the store via setInterruptArmDisplay so the
 * controls bar can show "again to exit".
 */
export function Live({ store }: { store: RunStore }) {
  const state = useStore(store);

  useEffect(() => {
    store.startClock();
    return () => store.stopClock();
  }, [store]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") interruptPress();
  });

  const onNav = useCallback((a: Parameters<RunStore["dispatchNav"]>[0]) => store.dispatchNav(a), [store]);
  const onHelp = useCallback((open: boolean) => store.setHelpOpen(open), [store]);
  const onSkipCountdown = useCallback(() => store.skipCountdown(), [store]);
  const prompt = useMemo(
    () => ({
      onAction: (a: Parameters<RunStore["dispatchPrompt"]>[0]) => store.dispatchPrompt(a),
      onSubmit: () => store.submitPrompt(),
      onCancel: () => store.cancelPrompt(),
    }),
    [store],
  );

  return <App state={state} onNav={onNav} onHelp={onHelp} prompt={prompt} onSkipCountdown={onSkipCountdown} />;
}
