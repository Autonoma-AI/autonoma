/**
 * Renders TUI fixture scenes to standalone HTML, so docs screenshots of the
 * planner dashboard are reproducible instead of a hand-taken photo of somebody's
 * terminal (which bakes in their font, theme and window size).
 *
 * The dashboard is Ink drawing a character grid to a TTY - there is no DOM to
 * screenshot. So: render the scene headlessly to an ANSI frame, translate the
 * SGR escapes into styled spans, and emit a page that Playwright can shoot at a
 * fixed size. See `apps/docs/screenshot-plan.md` for how the images are used.
 *
 * Usage:
 *   pnpm --filter @autonoma-ai/planner tui:frames <out-dir> [scene...]
 *
 * Then screenshot each page (from apps/ui, which has Playwright installed).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { render } from "ink-testing-library";
import React from "react";
import { App } from "../src/ui/App";
import { buildScenes } from "../src/ui/fixtures";

/** Wide enough that the FILES column and the activity feed both get their full layout. */
const SIZE = { columns: 132, rows: 34 };
const BACKGROUND = "#050505";
const DEFAULT_FOREGROUND = "#EDEDED";
const FONT_STACK = "'SFMono-Regular', 'JetBrains Mono', Menlo, Consolas, monospace";
const FONT_SIZE_PX = 13;
const LINE_HEIGHT = 1.35;

interface Style {
  color?: string;
  background?: string;
  bold: boolean;
  dim: boolean;
  inverse: boolean;
}

function emptyStyle(): Style {
  return { bold: false, dim: false, inverse: false };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "&nbsp;");
}

/**
 * Apply one SGR sequence's parameters. Ink emits truecolor (`38;2;r;g;b`) for
 * every themed color, so the 16-color and 256-color forms never appear here and
 * are deliberately not handled - an unknown parameter is skipped rather than
 * guessed at, which shows up as unstyled text rather than a wrong color.
 */
function applySgr(style: Style, params: number[]): Style {
  const next: Style = { ...style };
  for (let i = 0; i < params.length; i++) {
    const code = params[i];
    if (code === 0) {
      return emptyStyle();
    } else if (code === 1) {
      next.bold = true;
    } else if (code === 2) {
      next.dim = true;
    } else if (code === 7) {
      next.inverse = true;
    } else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 27) {
      next.inverse = false;
    } else if (code === 39) {
      next.color = undefined;
    } else if (code === 49) {
      next.background = undefined;
    } else if ((code === 38 || code === 48) && params[i + 1] === 2) {
      const [r, g, b] = [params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0];
      const rgb = `rgb(${r},${g},${b})`;
      if (code === 38) next.color = rgb;
      else next.background = rgb;
      i += 4;
    }
  }
  return next;
}

function styleToCss(style: Style): string {
  const foreground = style.color ?? DEFAULT_FOREGROUND;
  const background = style.background ?? BACKGROUND;
  const parts = style.inverse
    ? [`color:${background}`, `background:${foreground}`]
    : [`color:${foreground}`, ...(style.background != null ? [`background:${background}`] : [])];
  if (style.bold) parts.push("font-weight:700");
  if (style.dim) parts.push("opacity:.6");
  return parts.join(";");
}

function ansiToHtml(frame: string): string {
  const pattern = /\x1b\[([0-9;]*)m/g;
  let style = emptyStyle();
  let cursor = 0;
  let html = "";

  for (const match of frame.matchAll(pattern)) {
    const text = frame.slice(cursor, match.index);
    if (text.length > 0) html += `<span style="${styleToCss(style)}">${escapeHtml(text)}</span>`;
    const params = (match[1] ?? "").split(";").map((value) => (value === "" ? 0 : Number(value)));
    style = applySgr(style, params);
    cursor = (match.index ?? 0) + match[0].length;
  }
  const tail = frame.slice(cursor);
  if (tail.length > 0) html += `<span style="${styleToCss(style)}">${escapeHtml(tail)}</span>`;
  return html;
}

function page(frameHtml: string): string {
  return `<!doctype html><meta charset="utf-8"><title>planner TUI</title>
<style>
  html, body { margin: 0; background: ${BACKGROUND}; }
  pre {
    margin: 0;
    padding: 20px 24px;
    display: inline-block;
    font-family: ${FONT_STACK};
    font-size: ${FONT_SIZE_PX}px;
    line-height: ${LINE_HEIGHT};
    font-variant-ligatures: none;
    -webkit-font-smoothing: antialiased;
    white-space: pre;
  }
</style>
<pre>${frameHtml}</pre>`;
}

function main(): void {
  const [outDir, ...requested] = process.argv.slice(2);
  if (outDir == null) {
    console.error("Usage: render-tui-frames <out-dir> [scene...]");
    process.exit(1);
  }

  const scenes = buildScenes();
  const wanted = requested.length > 0 ? requested : scenes.map((scene) => scene.id);
  mkdirSync(outDir, { recursive: true });

  for (const id of wanted) {
    const scene = scenes.find((candidate) => candidate.id === id);
    if (scene == null) {
      console.error(`no fixture scene "${id}" - have: ${scenes.map((s) => s.id).join(", ")}`);
      process.exit(1);
    }
    const instance = render(React.createElement(App, { state: scene.store.getState(), onNav: () => {}, size: SIZE }));
    const frame = instance.lastFrame() ?? "";
    instance.unmount();

    const file = path.join(outDir, `${id}.html`);
    writeFileSync(file, page(ansiToHtml(frame)));
    console.log(`${file} (${frame.split("\n").length} rows x ${SIZE.columns} cols)`);
  }

  // Ink keeps timers and stdin handles alive after unmount; without this the
  // process hangs instead of exiting once every frame is written.
  process.exit(0);
}

main();
