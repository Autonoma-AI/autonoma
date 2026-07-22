import { render, type Instance } from "ink";
import { setInterruptArmDisplay } from "../core/interrupt";
import { registerUiLifecycle, registerUiTeardown } from "../core/ui-lifecycle";
import { readForLive } from "./artifacts/reader";
import { watchOutputDir } from "./artifacts/watcher";
import { Live } from "./Live";
import { createStore, setActiveStore, type RunStore } from "./store";
import type { MetaInfo } from "./types";

export interface MountOptions {
  outputDir: string;
  meta: MetaInfo;
}

export interface MountedUi {
  store: RunStore;
  /** Tear everything down and restore plain terminal output. */
  unmount: () => void;
}

interface ConsolePatch {
  restore: () => void;
}

/**
 * Route stray console.* from deep in the pipeline into the run log - direct
 * writes would scribble over the Ink frame.
 */
function patchConsole(store: RunStore): ConsolePatch {
  const orig = { log: console.log, error: console.error, warn: console.warn };
  const toLog =
    (level: "info" | "warn" | "error") =>
    (...args: unknown[]) =>
      store.appendLog({ level, text: args.map((a) => String(a)).join(" ") });
  console.log = toLog("info");
  console.error = toLog("error");
  console.warn = toLog("warn");
  return {
    restore: () => {
      console.log = orig.log;
      console.error = orig.error;
      console.warn = orig.warn;
    },
  };
}

/**
 * Mount the interactive Ink dashboard. Only called on a TTY (the caller
 * decides); headless runs never touch this module, so every store consumer
 * falls back to plain output.
 *
 * Registers a pause/resume lifecycle so the coding-agent handoff can take
 * the terminal: pause unmounts the Ink frame and restores console patching;
 * resume re-renders against the same store.
 */
export function mountUi(opts: MountOptions): MountedUi {
  const store = createStore({ outputDir: opts.outputDir, meta: opts.meta, reader: readForLive });
  setActiveStore(store);

  const stopWatch = watchOutputDir(opts.outputDir, (rel) => store.handleFsChange(rel));

  let ink: Instance | undefined;
  let consolePatch: ConsolePatch | undefined;

  const show = () => {
    consolePatch = patchConsole(store);
    // The arm hint renders in the controls bar only while the frame is up; a
    // stale arm state from before a pause must not survive the remount.
    store.setCtrlCArmed(false);
    setInterruptArmDisplay((armed) => store.setCtrlCArmed(armed));
    // patchConsole: false - our own console capture (above) already routes
    // stray logs into the store; Ink's would print them above the frame.
    ink = render(<Live store={store} />, { exitOnCtrlC: false, patchConsole: false });
  };

  const hide = () => {
    // While the TUI is down (the coding-agent handoff), the
    // Ctrl+C arm hint must fall back to stderr - routing it into an unmounted
    // tree would swallow the "press again to exit" feedback entirely.
    setInterruptArmDisplay(undefined);
    consolePatch?.restore();
    consolePatch = undefined;
    // Always clear the frame: whatever takes the terminal next (the user's
    // coding agent, the exit hint, the final outro) starts
    // on a clean region instead of under a stale dashboard.
    ink?.clear();
    ink?.unmount();
    ink = undefined;
  };

  const unmount = () => {
    registerUiTeardown(undefined);
    registerUiLifecycle(undefined);
    setInterruptArmDisplay(undefined);
    stopWatch();
    store.stopClock();
    hide();
    setActiveStore(undefined);
  };

  show();
  registerUiLifecycle({ pause: hide, resume: show });
  // Fatal paths (uncaught errors about to print + exit) can kill the frame
  // without holding a reference to this mount.
  registerUiTeardown(unmount);

  return { store, unmount };
}
