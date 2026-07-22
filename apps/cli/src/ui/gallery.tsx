import { Box, render, Text, useInput } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import { App } from "./App";
import { buildScenes, directoryScene, type Scene } from "./fixtures";
import { useStore } from "./hooks/useStore";
import { useTerminalSize } from "./hooks/useTerminalSize";
import { theme } from "./theme";

/**
 * Fixture-driven gallery: step through every dashboard state with Tab /
 * Shift+Tab and interact with each - navigation, cursor, opening artifacts and
 * scrolling all run against each scene's live store. No pipeline runs.
 *
 *   pnpm ui:gallery                                # canned fixture scenes
 *   pnpm ui:gallery /path/to/planner-output-dir    # + a scene with real files
 *
 * Pass a past run's output dir (e.g. ~/.autonoma/<slug>) to test navigation
 * over real artifacts: the hero reads the actual files from disk. The gallery
 * paints immediately; the directory scene slots in once its scan finishes.
 */
function Gallery({ scenes: initialScenes, dir, onQuit }: { scenes: Scene[]; dir?: string; onQuit: () => void }) {
  const [scenes, setScenes] = useState(initialScenes);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (dir == null) return;
    let cancelled = false;
    void directoryScene(dir).then((scene) => {
      if (!cancelled) setScenes((prev) => [scene, ...prev]);
    });
    return () => {
      cancelled = true;
    };
  }, [dir]);

  useInput((input, key) => {
    // Handle Ctrl+C ourselves: Ink's default exit leaves the last frame on
    // screen; we clear it before unmounting.
    if (key.ctrl && input === "c") onQuit();
    else if (key.tab) {
      setIdx((i) => (key.shift ? Math.max(0, i - 1) : Math.min(scenes.length - 1, i + 1)));
    }
  });

  const scene = scenes[Math.min(idx, scenes.length - 1)]!;
  const state = useStore(scene.store);
  const measured = useTerminalSize();
  const onNav = useCallback(
    (a: Parameters<Scene["store"]["dispatchNav"]>[0]) => scene.store.dispatchNav(a),
    [scene.store],
  );
  const onHelp = useCallback((open: boolean) => scene.store.setHelpOpen(open), [scene.store]);
  const onSkipCountdown = useCallback(() => scene.store.skipCountdown(), [scene.store]);
  const prompt = useMemo(
    () => ({
      onAction: (a: Parameters<Scene["store"]["dispatchPrompt"]>[0]) => scene.store.dispatchPrompt(a),
      onSubmit: () => scene.store.submitPrompt(),
      onCancel: () => scene.store.cancelPrompt(),
    }),
    [scene.store],
  );
  const size = useMemo(
    () => ({ columns: measured.columns, rows: measured.rows - 1 }),
    [measured.columns, measured.rows],
  );

  return (
    <Box flexDirection="column">
      {/* One row shorter than the terminal so the gallery footer below never
          pushes the frame into scrollback (scrolled-out lines can't be cleared). */}
      <App state={state} onNav={onNav} onHelp={onHelp} prompt={prompt} onSkipCountdown={onSkipCountdown} size={size} />
      <Text color={theme.tertiary}>
        Scene {idx + 1}/{scenes.length} · {scene.label} · Tab next · ⇧Tab prev · Ctrl+C quit
      </Text>
    </Box>
  );
}

async function main() {
  const dir = process.argv[2];
  const quit = () => {
    // Erase the frame, then unmount - clearing after Ink has torn down is a
    // no-op, which is exactly how stale dashboards were left behind.
    instance.clear();
    instance.unmount();
  };
  const instance = render(<Gallery scenes={buildScenes()} dir={dir} onQuit={quit} />, { exitOnCtrlC: false });
  await instance.waitUntilExit();
}

void main();
