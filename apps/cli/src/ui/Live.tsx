import { useInput, type Key } from "ink";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { track } from "../core/analytics";
import { interruptPress } from "../core/interrupt";
import { App } from "./App";
import { useStore } from "./hooks/useStore";
import { useTerminalSize } from "./hooks/useTerminalSize";
import type { RunStore } from "./store";
import { terminalFitsDashboard } from "./viewport";

/**
 * Binds the live run store to the presentational <App> and owns Ctrl+C.
 *
 * Ink is mounted with exitOnCtrlC: false, so Ctrl+C arrives here as raw input.
 * Presses are fed to the shared interrupt policy (double-press to exit); the
 * arm state comes back into the store via setInterruptArmDisplay so the
 * controls bar can show "again to exit".
 *
 * This is also the single place every keystroke passes through, so it is where
 * session replay taps them (see `onKeystroke`).
 */
export function Live({ store, onKeystroke }: { store: RunStore; onKeystroke?: (label: string) => void }) {
  const state = useStore(store);

  useEffect(() => {
    store.startClock();
    return () => store.stopClock();
  }, [store]);

  // A window too small to draw the dashboard in is invisible from the outside -
  // the run looks like it is progressing normally while the user sees a resize
  // notice instead of the UI. Report it, with the size that caused it.
  const size = useTerminalSize();
  const fits = terminalFitsDashboard(size);
  const reported = useRef(false);
  useEffect(() => {
    if (fits) {
      reported.current = false;
      return;
    }
    // Once per spell, not once per resize event: dragging a window smaller
    // emits a size change per frame, and every one of them is the same fact.
    if (reported.current) return;
    reported.current = true;
    track("cli_terminal_too_small", { columns: size.columns, rows: size.rows });
  }, [fits, size]);

  useInput((input, key) => {
    onKeystroke?.(describeKey(input, key));
    if (key.ctrl && input === "c") interruptPress();
  });

  const onNav = useCallback((a: Parameters<RunStore["dispatchNav"]>[0]) => store.dispatchNav(a), [store]);
  const onHelp = useCallback((open: boolean) => store.setHelpOpen(open), [store]);
  const onSkipCountdown = useCallback(() => store.skipCountdown(), [store]);
  const onDismissWelcome = useCallback(() => store.dismissWelcome(), [store]);
  const onCompletionChoice = useCallback(
    (choice: Parameters<RunStore["setCompletionChoice"]>[0]) => store.setCompletionChoice(choice),
    [store],
  );
  const onSubmitCompletion = useCallback(() => store.submitCompletion(), [store]);
  const onExitBrowse = useCallback(() => store.exitBrowse(), [store]);
  const prompt = useMemo(
    () => ({
      onAction: (a: Parameters<RunStore["dispatchPrompt"]>[0]) => store.dispatchPrompt(a),
      onSubmit: () => store.submitPrompt(),
      onCancel: () => store.cancelPrompt(),
    }),
    [store],
  );

  return (
    <App
      state={state}
      onNav={onNav}
      onHelp={onHelp}
      prompt={prompt}
      onSkipCountdown={onSkipCountdown}
      onDismissWelcome={onDismissWelcome}
      onCompletionChoice={onCompletionChoice}
      onSubmitCompletion={onSubmitCompletion}
      onExitBrowse={onExitBrowse}
    />
  );
}

/** Ordered so the first match wins; `ctrl` is checked with the letter it modifies. */
const NAMED_KEYS: [keyof Key, string][] = [
  ["upArrow", "up"],
  ["downArrow", "down"],
  ["leftArrow", "left"],
  ["rightArrow", "right"],
  ["pageUp", "pageup"],
  ["pageDown", "pagedown"],
  ["return", "enter"],
  ["escape", "esc"],
  ["tab", "tab"],
  ["backspace", "backspace"],
  ["delete", "delete"],
];

/**
 * Name a keystroke for the replay timeline without reproducing what was typed.
 *
 * A printable character collapses to a placeholder on purpose: the prompt panel
 * accepts free text a user could paste a token into, and while the frame itself
 * would show it, we are not also going to ship a clean, trivially reassembled
 * transcript of their keyboard.
 */
function describeKey(input: string, key: Key): string {
  for (const [flag, name] of NAMED_KEYS) {
    if (key[flag]) return name;
  }
  if (key.ctrl) return `ctrl+${input}`;
  return "char";
}
