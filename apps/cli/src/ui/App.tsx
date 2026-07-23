import { useInput, type Key } from "ink";
import { useEffect } from "react";
import { heroViewportCols, heroViewportRows } from "./draw/dashboard";
import { useTerminalSize, type TermSize } from "./hooks/useTerminalSize";
import type { NavAction } from "./nav";
import type { PromptAction } from "./prompt";
import { Dashboard } from "./screens/Dashboard";
import type { PromptRequest, RunState } from "./types";

/** Everything a prompt needs from the outside: draft edits, submit, cancel. */
export interface PromptHandlers {
  onAction: (a: PromptAction) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/**
 * The presentational shell: terminal-size-aware, key handling, and the screen
 * switch. Pure projection of RunState - all state lives in the store.
 */
export function App({
  state,
  onNav,
  onHelp,
  prompt,
  onSkipCountdown,
  onDismissWelcome,
  size,
}: {
  state: RunState;
  onNav: (a: NavAction) => void;
  /** Show/hide the help modal; omitted in static renders. */
  onHelp?: (open: boolean) => void;
  /** Answering machinery for the docked prompt panel; omitted in static renders. */
  prompt?: PromptHandlers;
  /** Enter on the pre-handoff countdown: continue immediately. */
  onSkipCountdown?: () => void;
  /** Enter on the opening welcome: begin the run. */
  onDismissWelcome?: () => void;
  size?: TermSize;
}) {
  const measured = useTerminalSize();
  const { rows, columns } = size ?? measured;
  const gridRows = Math.max(10, rows - 1);

  // Tell the nav reducer how tall the viewer is, so unfollowing starts
  // scrolling from the tail position that's actually on screen.
  useEffect(() => {
    onNav({ type: "setViewport", rows: heroViewportRows(columns, gridRows), cols: heroViewportCols(columns) });
  }, [columns, gridRows, onNav]);

  useInput((input, key) => {
    // While help is open it swallows the keyboard: ? / esc / q close it.
    if (state.helpOpen) {
      if (input === "?" || key.escape || input === "q") onHelp?.(false);
      return;
    }

    // The opening welcome: enter begins, nothing else.
    if (state.welcome != null) {
      if (key.return) onDismissWelcome?.();
      return;
    }

    // The pre-handoff countdown: enter continues immediately, nothing else.
    if (state.countdown != null) {
      if (key.return) onSkipCountdown?.();
      return;
    }

    // A blocking question owns the keyboard until answered.
    const activePrompt = state.prompt.current;
    if (activePrompt != null && prompt != null) {
      handlePromptKey(activePrompt, input, key, prompt);
      return;
    }

    if (input === "?") onHelp?.(true);
    else if (key.escape) {
      if (state.nav.focus === "main") onNav({ type: "focusLeft" });
      else onNav({ type: "closeDocument" });
    } else if (key.leftArrow || input === "h") onNav({ type: "focusLeft" });
    else if (key.rightArrow || input === "l") onNav({ type: "focusRight" });
    else if (key.upArrow || input === "k") onNav({ type: "moveUp" });
    else if (key.downArrow || input === "j") onNav({ type: "moveDown" });
    else if (key.return) onNav({ type: "enter" });
    else if (key.pageUp) onNav({ type: "pageUp" });
    else if (key.pageDown) onNav({ type: "pageDown" });
    else if (input === "f") onNav({ type: "toggleFollow" });
    else if (input === "g") onNav({ type: "scrollTop" });
    else if (input === "G") onNav({ type: "scrollBottom" });
  });

  // Leave one terminal row free: rendering exactly `rows` lines makes the
  // terminal scroll and the frame walks off-screen (inline rendering).
  return <Dashboard state={state} width={columns} rows={gridRows} />;
}

function handlePromptKey(req: PromptRequest, input: string, key: Key, handlers: PromptHandlers): void {
  if (key.escape) {
    handlers.onCancel();
    return;
  }
  if (key.return) {
    handlers.onSubmit();
    return;
  }

  if (req.kind === "text") {
    // Free typing: every printable character is input, never a hotkey.
    if (key.leftArrow) handlers.onAction({ type: "left" });
    else if (key.rightArrow) handlers.onAction({ type: "right" });
    else if (key.upArrow) handlers.onAction({ type: "home" });
    else if (key.downArrow) handlers.onAction({ type: "end" });
    else if (key.backspace) handlers.onAction({ type: "backspace" });
    else if (key.delete) handlers.onAction({ type: "delete" });
    else if (input !== "" && !key.ctrl && !key.meta) handlers.onAction({ type: "input", text: input });
    return;
  }

  if (req.kind === "confirm") {
    if (input === "y" || input === "Y") {
      handlers.onAction({ type: "setIndex", index: 0 });
      handlers.onSubmit();
      return;
    }
    if (input === "n" || input === "N") {
      handlers.onAction({ type: "setIndex", index: 1 });
      handlers.onSubmit();
      return;
    }
  }

  if (key.upArrow || input === "k" || key.leftArrow || input === "h") handlers.onAction({ type: "up" });
  else if (key.downArrow || input === "j" || key.rightArrow || input === "l") handlers.onAction({ type: "down" });
  else if (input === " ") handlers.onAction({ type: "toggle" });
}
