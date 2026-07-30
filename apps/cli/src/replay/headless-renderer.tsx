import { EventEmitter } from "node:events";
import { render, type Instance } from "ink";
import { App } from "../ui/App";
import type { TermSize } from "../ui/hooks/useTerminalSize";
import type { RunState } from "../ui/types";

/**
 * Collects Ink's output instead of writing it anywhere. `columns`/`rows` are
 * read by Ink for wrapping, so they must mirror the real terminal.
 */
class FrameSink extends EventEmitter {
  public last = "";
  public readonly isTTY = true;

  constructor(
    public readonly columns: number,
    public readonly rows: number,
  ) {
    super();
  }

  public readonly write = (chunk: string): void => {
    this.last = chunk;
  };
}

/**
 * Ink refuses to render without a raw-mode-capable stdin, and we must never
 * touch the real one - the live dashboard owns it.
 */
class DetachedStdin extends EventEmitter {
  public readonly isTTY = true;
  public setEncoding(): void {}
  public setRawMode(): void {}
  public resume(): void {}
  public pause(): void {}
  public ref(): void {}
  public unref(): void {}
  public readonly read = (): null => null;
}

/**
 * Renders the dashboard a second time, off-screen, to obtain the exact frame
 * the user is looking at.
 *
 * The obvious alternative - scraping the repaint stream Ink writes to the
 * terminal - is not viable: Ink can emit either a full redraw or a per-line
 * incremental update depending on internal options, so reconstructing a frame
 * from it would mean shipping a terminal emulator. `debug: true` is a public
 * Ink option that makes it write the complete frame with no cursor escapes,
 * which is exactly the input the converter wants.
 *
 * <App> is a pure function of (state, size), so this render can never diverge
 * from the visible one, and `onNav` is a no-op here so the off-screen tree
 * cannot write back into the run's store.
 *
 * The streams below are accepted by `render` because `patches/ink@7.1.1.patch`
 * types its stdout/stdin options structurally instead of as full tty streams.
 * Without that patch this file needs two `as unknown as` assertions; see the
 * patch and `docs/ink-stream-types-upstream.md`.
 */
export class HeadlessRenderer {
  private readonly sink: FrameSink;
  private ink?: Instance;

  constructor(private readonly size: TermSize) {
    this.sink = new FrameSink(size.columns, size.rows);
  }

  /** The frame <App> would paint for this state, as an ANSI string. */
  public frame(state: RunState): string {
    const tree = <App state={state} onNav={noop} size={this.size} />;
    if (this.ink == null) {
      this.ink = render(tree, {
        stdout: this.sink,
        stdin: new DetachedStdin(),
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      });
    } else {
      this.ink.rerender(tree);
    }
    return this.sink.last;
  }

  public dispose(): void {
    this.ink?.unmount();
    this.ink = undefined;
  }
}

function noop(): void {}
