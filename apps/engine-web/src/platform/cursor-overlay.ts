import { type Logger, logger } from "@autonoma/logger";
import type { BrowserContext, Page } from "playwright";
import type { ActivePageManager } from "./active-page-manager";

/**
 * Draws a synthetic mouse pointer into the page so the run recording shows where the agent is
 * acting. Playwright dispatches mouse events straight into the renderer via CDP, so neither the
 * video nor a screenshot contains a real cursor - without this, a recording of a run is a series
 * of unexplained state changes.
 *
 * The overlay is cosmetic only: it never moves the real pointer. Gliding a live pointer between
 * two points would drag it across whatever lies in between, opening hover menus and tooltips that
 * can then swallow the click.
 */

/** Element ids in the page. Namespaced to avoid colliding with anything the app under test owns. */
const CURSOR_ID = "__autonoma-cursor";
const RING_ID = "__autonoma-cursor-ring";

/**
 * Glide duration. Long enough to read as movement to a human watching the recording, short enough
 * that it costs ~nothing: the reviewer's video is sampled at 1 fps, so a glide this short is
 * almost never caught mid-flight, and the ease-out curve puts the pointer ~87% of the way to its
 * destination by the halfway mark anyway.
 */
const GLIDE_MS = 250;

/** Slower for drags, where the path itself is the thing being demonstrated. */
const DRAG_GLIDE_MS = 450;

/**
 * How long the click ring stays up. It must outlive the 1 fps sampling interval by a wide margin
 * or the reviewer model never sees a single frame containing it - which is the whole reason the
 * ring exists. Whichever comes first clears it: the next move, or this timer as the fallback for a
 * click the run never moves away from.
 */
const RING_VISIBLE_MS = 2000;

/** Pointer glyph size in CSS pixels. A real Chrome pointer is ~12x19; this matches it closely. */
const CURSOR_WIDTH = 13;
const CURSOR_HEIGHT = 21;

/** Above any app content. Max 32-bit signed int, the conventional "always on top" z-index. */
const Z_INDEX = 2147483647;

interface Point {
    x: number;
    y: number;
}

/**
 * Source of the script that runs in the page, once per document. It builds the pointer and the
 * click ring with DOM calls only - no innerHTML and no data: URIs - so a strict CSP
 * (`require-trusted-types-for`, a narrow `img-src`) on the app under test cannot block it.
 *
 * This is a STRING and not a function on purpose. Playwright ships an init script by serialising
 * it with `Function.prototype.toString`, and esbuild (which tsx uses) rewrites named function
 * declarations to `__name(function build() {...}, "build")` under keep-names. That helper only
 * exists in the bundle, never in the page, so a serialised function throws
 * "__name is not defined" at document start and the overlay silently never mounts. A string is
 * immune to whatever the bundler does to this file.
 */
function cursorScriptSource(config: {
    cursorId: string;
    ringId: string;
    width: number;
    height: number;
    glideMs: number;
    zIndex: number;
}): string {
    const { cursorId, ringId, width, height, glideMs, zIndex } = config;

    return `
(() => {
    var SVG_NS = "http://www.w3.org/2000/svg";
    var CURSOR_ID = ${JSON.stringify(cursorId)};
    var RING_ID = ${JSON.stringify(ringId)};

    // Holds the mounted pointer so the observer below can bail on a property read instead of a
    // document-wide id lookup - it runs after every render batch in the app under test.
    var mounted = null;

    var build = () => {
        if (mounted && mounted.isConnected) return;

        var root = document.body || document.documentElement;
        if (!root) return;
        if (document.getElementById(CURSOR_ID)) return;

        var ring = document.createElement("div");
        ring.id = RING_ID;
        ring.style.position = "fixed";
        ring.style.left = "0";
        ring.style.top = "0";
        ring.style.width = "34px";
        ring.style.height = "34px";
        ring.style.marginLeft = "-17px";
        ring.style.marginTop = "-17px";
        ring.style.borderRadius = "50%";
        ring.style.border = "2px solid rgba(255, 60, 60, 0.9)";
        ring.style.boxShadow = "0 0 0 1px rgba(0, 0, 0, 0.45)";
        ring.style.opacity = "0";
        ring.style.pointerEvents = "none";
        ring.style.zIndex = "${zIndex - 1}";
        ring.style.transition = "opacity 120ms linear";

        var cursor = document.createElement("div");
        cursor.id = CURSOR_ID;
        cursor.style.position = "fixed";
        cursor.style.left = "0";
        cursor.style.top = "0";
        cursor.style.width = "${width}px";
        cursor.style.height = "${height}px";
        cursor.style.pointerEvents = "none";
        cursor.style.zIndex = "${zIndex}";
        cursor.style.transform = "translate3d(-100px, -100px, 0)";
        cursor.style.transition = "transform ${glideMs}ms cubic-bezier(0.22, 1, 0.36, 1)";
        cursor.style.willChange = "transform";

        var svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("width", "${width}");
        svg.setAttribute("height", "${height}");
        svg.setAttribute("viewBox", "0 0 12 19");

        var path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("d", "M0 0 L0 16.5 L4.2 12.4 L6.6 18 L9 17 L6.6 11.4 L11.4 11.4 Z");
        path.setAttribute("fill", "#ffffff");
        path.setAttribute("stroke", "#000000");
        path.setAttribute("stroke-width", "1");
        path.setAttribute("stroke-linejoin", "round");

        svg.appendChild(path);
        cursor.appendChild(svg);
        root.appendChild(ring);
        root.appendChild(cursor);
        mounted = cursor;
    };

    build();
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);

    // The document at script time is not the one the app ends up rendering into, and a framework
    // can replace the tree at any point in the run - so watch the whole document and rebuild when
    // the nodes go. Never disconnected: the wipe this guards against can happen long after mount.
    new MutationObserver(build).observe(document, { childList: true, subtree: true });
})();
`;
}

export class CursorOverlay {
    private readonly logger: Logger;

    constructor(private readonly pageManager: ActivePageManager) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    /**
     * Registers the overlay on the context so every document - the initial page, later navigations,
     * and any tab opened during the run - draws it. Must run before the first page is created.
     */
    public static async install(context: BrowserContext): Promise<void> {
        logger.child({ name: "CursorOverlay" }).info("Installing cursor overlay init script");
        await context.addInitScript({
            content: cursorScriptSource({
                cursorId: CURSOR_ID,
                ringId: RING_ID,
                width: CURSOR_WIDTH,
                height: CURSOR_HEIGHT,
                glideMs: GLIDE_MS,
                zIndex: Z_INDEX,
            }),
        });
    }

    /** Glides the pointer to a point and resolves once the glide has finished. */
    public async moveTo(point: Point, durationMs: number = GLIDE_MS): Promise<void> {
        const moved = await this.apply((page) =>
            page.evaluate(
                ({ cursorId, ringId, x, y, duration }) => {
                    const cursor = document.getElementById(cursorId);
                    const ring = document.getElementById(ringId);
                    if (ring != null) {
                        const pending = Number(ring.dataset.hideTimer ?? "");
                        if (pending > 0) window.clearTimeout(pending);
                        delete ring.dataset.hideTimer;
                        ring.style.opacity = "0";
                    }
                    if (cursor == null) return false;

                    cursor.style.transitionDuration = `${duration}ms`;
                    cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
                    return true;
                },
                { cursorId: CURSOR_ID, ringId: RING_ID, x: point.x, y: point.y, duration: durationMs },
            ),
        );

        // Let the CSS transition actually play before the caller dispatches the real event, so the
        // recording shows the pointer arriving at the element ahead of the app reacting to it.
        if (moved === true) await this.pageManager.current.waitForTimeout(durationMs);
    }

    /** Marks a click at a point: the ring stays up long enough to survive 1 fps video sampling. */
    public async markClick(point: Point): Promise<void> {
        await this.apply((page) =>
            page.evaluate(
                ({ ringId, x, y, visibleMs }) => {
                    const ring = document.getElementById(ringId);
                    if (ring == null) return;

                    // Cancel the previous ring's fade first: two clicks closer together than
                    // visibleMs would otherwise have the older timer hide the newer ring early.
                    const pending = Number(ring.dataset.hideTimer ?? "");
                    if (pending > 0) window.clearTimeout(pending);

                    ring.style.transform = `translate3d(${x}px, ${y}px, 0)`;
                    ring.style.opacity = "1";

                    const timer = window.setTimeout(() => {
                        ring.style.opacity = "0";
                        delete ring.dataset.hideTimer;
                    }, visibleMs);
                    ring.dataset.hideTimer = String(timer);
                },
                { ringId: RING_ID, x: point.x, y: point.y, visibleMs: RING_VISIBLE_MS },
            ),
        );
    }

    /** Glides along a drag path, slower, so the direction of travel is legible in the recording. */
    public async dragTo(point: Point): Promise<void> {
        await this.moveTo(point, DRAG_GLIDE_MS);
    }

    /**
     * Shows or hides the overlay. Screenshots hide it: the step screenshot the UI renders is the
     * one taken BEFORE the agent picks its command, so a drawn pointer there is always one action
     * stale - it would sit on the previous target while the UI's own marker points at the next one.
     * The UI draws that marker itself from the step's result, scaled to the rendered image, so the
     * pixels only need to carry the cursor for the video.
     */
    public async setVisible(visible: boolean): Promise<void> {
        await this.apply((page) =>
            page.evaluate(
                ({ cursorId, ringId, value }) => {
                    const cursor = document.getElementById(cursorId);
                    const ring = document.getElementById(ringId);
                    if (cursor != null) cursor.style.visibility = value;
                    if (ring != null) ring.style.visibility = value;
                },
                { cursorId: CURSOR_ID, ringId: RING_ID, value: visible ? "visible" : "hidden" },
            ),
        );
    }

    /**
     * Runs an overlay update against the active page. The overlay is decoration: a page that is
     * mid-navigation (or has just closed) makes `evaluate` throw, and that must never fail a step.
     */
    private async apply<T>(work: (page: Page) => Promise<T>): Promise<T | undefined> {
        try {
            return await work(this.pageManager.current);
        } catch (error) {
            this.logger.debug("Cursor overlay update skipped", { err: error });
            return undefined;
        }
    }
}
