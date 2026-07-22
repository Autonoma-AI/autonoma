import { render } from "ink-testing-library";
import { describe, expect, test, vi } from "vitest";
import { App } from "../../src/ui/App";
import { buildScenes } from "../../src/ui/fixtures";

const SIZE = { columns: 120, rows: 36 };
const SCENES = buildScenes();

function sceneState(id: string) {
  const scene = SCENES.find((s) => s.id === id);
  if (scene == null) throw new Error(`no fixture scene "${id}"`);
  return scene.store.getState();
}

describe("dashboard rendering", () => {
  test("early scene shows chrome, the pipeline strip and an empty-state hero", () => {
    const { lastFrame, unmount } = render(<App state={sceneState("early")} onNav={() => {}} size={SIZE} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("autonoma");
    expect(frame).toContain("FILES");
    expect(frame).toContain("Map project");
    expect(frame).toContain("Map pages");
    expect(frame).toContain("no document yet");
    expect(frame).toContain("ACTIVITY");
    unmount();
  });

  test("mid-run scene shows sub-progress, artifact statuses and the live document", () => {
    const { lastFrame, unmount } = render(<App state={sceneState("mid")} onNav={() => {}} size={SIZE} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("9/24");
    expect(frame).toContain("AUTONOMA.md");
    expect(frame).toContain("WRITING");
    expect(frame).toContain("Acme Storefront");
    expect(frame).toContain("FOLLOWING LATEST");
    unmount();
  });

  test("complete scene reads complete with every step done", () => {
    const { lastFrame, unmount } = render(<App state={sceneState("done")} onNav={() => {}} size={SIZE} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("complete");
    expect(frame).toContain("100%");
    expect(frame).not.toContain("◐");
    unmount();
  });

  test("the empty-state hero links the running step's docs page", async () => {
    const { createStore } = await import("../../src/ui/store");
    const store = createStore({ outputDir: "/out", meta: { title: "t", project: "p", version: "0" } });
    store.startStep("recipeBuilder");
    const { lastFrame, unmount } = render(
      <App state={store.getState()} onNav={() => {}} size={{ columns: 160, rows: 40 }} />,
    );
    expect(lastFrame() ?? "").toContain("docs.autonoma.app/environment-factory");
    unmount();
  });

  test("the help modal explains the current step and lists the pipeline + keys", () => {
    const state = { ...sceneState("mid"), helpOpen: true };
    const { lastFrame, unmount } = render(<App state={state} onNav={() => {}} size={SIZE} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("What's happening - Build knowledge base");
    expect(frame).toContain("THE PIPELINE");
    expect(frame).toContain("KEYS");
    expect(frame).toContain("? or esc to close");
    unmount();
  });

  test("esc walks the ladder: document -> files -> step explainer", async () => {
    const docFocused = { ...sceneState("mid") };
    docFocused.nav = { ...docFocused.nav, focus: "main" as const };
    const fromDoc: string[] = [];
    const first = render(<App state={docFocused} onNav={(a) => fromDoc.push(a.type)} size={SIZE} />);
    first.stdin.write("\u001B"); // esc
    await vi.waitFor(() => {
      expect(fromDoc).toContain("focusLeft");
    });
    first.unmount();

    // Files focused (the mid scene default): esc closes the document.
    const fromFiles: string[] = [];
    const second = render(<App state={sceneState("mid")} onNav={(a) => fromFiles.push(a.type)} size={SIZE} />);
    second.stdin.write("\u001B"); // esc
    await vi.waitFor(() => {
      expect(fromFiles).toContain("closeDocument");
    });
    second.unmount();
  });

  test("an active prompt shows as a centered ACTION REQUIRED modal", () => {
    const scene = buildScenes().find((s) => s.id === "prompt")!;
    const { lastFrame, unmount } = render(<App state={scene.store.getState()} onNav={() => {}} size={SIZE} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("ACTION REQUIRED");
    expect(frame).toContain("Which frontend do you want to plan tests for?");
    expect(frame).toContain("apps/web");
    expect(frame).toContain("+3 more after this");
    unmount();
  });

  test("a failed run shows stopped in the top bar, not complete", async () => {
    const { createStore } = await import("../../src/ui/store");
    const store = createStore({ outputDir: "/out", meta: { title: "t", project: "p", version: "0" } });
    store.endStep("pagesFinder", "failed");
    store.finish({ kind: "failed" });
    const { lastFrame, unmount } = render(<App state={store.getState()} onNav={() => {}} size={SIZE} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("stopped");
    expect(frame).not.toContain("complete");
    unmount();
  });

  test("the help modal lists recent problems", () => {
    const scene = buildScenes().find((s) => s.id === "mid")!;
    scene.store.appendLog({ level: "error", text: "provider exploded during kb step" });
    scene.store.setHelpOpen(true);
    const { lastFrame, unmount } = render(<App state={scene.store.getState()} onNav={() => {}} size={SIZE} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("RECENT PROBLEMS");
    expect(frame).toContain("provider exploded during kb step");
    unmount();
  });

  test("armed Ctrl+C shows the exit hint in the controls bar", () => {
    const state = { ...sceneState("mid"), ctrlCArmed: true };
    const { lastFrame, unmount } = render(<App state={state} onNav={() => {}} size={SIZE} />);
    expect(lastFrame() ?? "").toContain("again to exit");
    unmount();
  });
});
