import { render } from "ink-testing-library";
import { describe, expect, test, vi } from "vitest";
import { App } from "../../src/ui/App";
import { buildScenes } from "../../src/ui/fixtures";
import { MIN_COLUMNS, MIN_ROWS } from "../../src/ui/viewport";

const SCENES = buildScenes();

function sceneState(id: string) {
  const scene = SCENES.find((s) => s.id === id);
  if (scene == null) throw new Error(`no fixture scene "${id}"`);
  return scene.store.getState();
}

/** The shape that broke: very wide, far too short to lay the dashboard out in. */
const SQUASHED = { columns: 200, rows: 12 };
const AT_FLOOR = { columns: MIN_COLUMNS, rows: MIN_ROWS };

describe("the resize notice", () => {
  test("a squashed terminal gets the resize notice instead of a folded-up dashboard", () => {
    const { lastFrame, unmount } = render(<App state={sceneState("mid")} onNav={() => {}} size={SQUASHED} />);
    const frame = lastFrame() ?? "";
    // An instruction, not an error - it keeps the brand line and leads with
    // what to do, so nobody reads it as a crash.
    expect(frame).toContain("autonoma");
    expect(frame).toContain("Expand this window to see the dashboard");
    expect(frame).toContain(
      `Drag it taller - the dashboard needs ${MIN_COLUMNS}x${MIN_ROWS}, and this window is 200x12.`,
    );
    expect(frame).toContain("Your run carries on in the background.");
    // None of the dashboard regions may be drawn - overlapping them is the bug.
    expect(frame).not.toContain("ACTIVITY");
    expect(frame).not.toContain("FILES");
    unmount();
  });

  test("the notice names the axis that is actually short", () => {
    const narrow = render(<App state={sceneState("mid")} onNav={() => {}} size={{ columns: 60, rows: 40 }} />);
    expect(narrow.lastFrame() ?? "").toContain("Drag it wider");
    narrow.unmount();

    const both = render(<App state={sceneState("mid")} onNav={() => {}} size={{ columns: 60, rows: 12 }} />);
    expect(both.lastFrame() ?? "").toContain("Drag it bigger");
    both.unmount();
  });

  test("a blocked run says so, since the question itself cannot be shown", () => {
    const { lastFrame, unmount } = render(<App state={sceneState("prompt")} onNav={() => {}} size={SQUASHED} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("A question is waiting for you on the dashboard.");
    expect(frame).not.toContain("ACTION REQUIRED");
    unmount();
  });

  test("keys are swallowed while the notice is up, so nothing is answered blind", async () => {
    const actions: string[] = [];
    const { stdin, unmount } = render(
      <App state={sceneState("mid")} onNav={(a) => actions.push(a.type)} size={SQUASHED} />,
    );
    stdin.write("j");
    stdin.write("\r");
    stdin.write("");
    await vi.waitFor(() => {
      expect(actions.filter((a) => a !== "setViewport")).toHaveLength(0);
    });
    unmount();
  });

  test("exactly at the floor the dashboard draws normally", () => {
    const { lastFrame, unmount } = render(<App state={sceneState("mid")} onNav={() => {}} size={AT_FLOOR} />);
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Expand this window");
    expect(frame).toContain("FILES");
    expect(frame).toContain("ACTIVITY");
    unmount();
  });

  test("the frame never draws more lines than the terminal has", () => {
    for (const size of [SQUASHED, AT_FLOOR, { columns: 40, rows: 4 }]) {
      const { lastFrame, unmount } = render(<App state={sceneState("mid")} onNav={() => {}} size={size} />);
      expect((lastFrame() ?? "").split("\n").length).toBeLessThan(size.rows);
      unmount();
    }
  });
});

describe("welcome modal on a short terminal", () => {
  test("a body too tall to fit is clamped and says how much is missing", () => {
    const { lastFrame, unmount } = render(
      <App state={sceneState("no-agent")} onNav={() => {}} size={{ columns: MIN_COLUMNS, rows: MIN_ROWS }} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("NO CODING AGENT FOUND");
    expect(frame).toMatch(/\+\d+ more lines - make the terminal taller/);
    // The call to action is the whole point of the modal; it must survive.
    expect(frame).toContain("Press enter once you have handed it over");
    unmount();
  });

  test("dropping the blank line between paragraphs buys back the rows, so nothing is cut", () => {
    const { lastFrame, unmount } = render(
      <App state={sceneState("no-agent")} onNav={() => {}} size={{ columns: 120, rows: MIN_ROWS }} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("When your agent reports it finished");
    expect(frame).not.toContain("more lines - make the terminal taller");
    unmount();
  });

  test("with room to spare the whole body renders and nothing is marked hidden", () => {
    const { lastFrame, unmount } = render(
      <App state={sceneState("no-agent")} onNav={() => {}} size={{ columns: 120, rows: 44 }} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("When your agent reports it finished");
    expect(frame).not.toContain("more lines - make the terminal taller");
    unmount();
  });
});
