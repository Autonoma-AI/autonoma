import { REPLAY_BACKGROUND, REPLAY_FOREGROUND, type StyledRun, type TerminalRow } from "./ansi-to-rows";
import {
    NODE_TYPE,
    type FullSnapshotEvent,
    type MutationEvent,
    type NodeAddition,
    type NodeRemoval,
    type ReplayEvent,
    type SerializedNode,
} from "./types";

// Fixed ids for the document scaffold; rows and spans are allocated above them.
const DOCUMENT_ID = 1;
const DOCTYPE_ID = 2;
const HTML_ID = 3;
const HEAD_ID = 4;
const STYLE_ID = 5;
const BODY_ID = 6;
const PRE_ID = 7;
/** The <input> that keystroke events target; needs a node that outlives rows. */
export const KEY_TARGET_ID = 8;
const ROW_ID_BASE = 1_000;
const SPAN_ID_BASE = 100_000;

const CSS = `
html,body{margin:0;padding:0;background:${REPLAY_BACKGROUND};}
pre{margin:0;padding:18px 22px;background:${REPLAY_BACKGROUND};color:${REPLAY_FOREGROUND};
font-family:'SFMono-Regular','JetBrains Mono',Menlo,Consolas,monospace;font-size:13px;line-height:1.35;
font-variant-ligatures:none;white-space:pre;tab-size:4;}
pre>div{white-space:pre;min-height:1.35em;}
span{white-space:pre;}
input{position:absolute;left:-9999px;}
`;

/**
 * Turns a stream of rendered frames into rrweb events.
 *
 * The first frame (and any frame that changes the row count) becomes a full
 * snapshot; every other frame becomes a mutation that rebuilds only the rows
 * whose content actually changed. That distinction is what makes a long run
 * affordable - a full snapshot of the dashboard is ~35KB, while a typical
 * repaint touches the clock and a progress bar and costs a few hundred bytes.
 */
export class FrameDiffer {
    private previous?: TerminalRow[];
    /** Span node ids currently mounted under each row, parallel to `previous`. */
    private mountedSpanIds: number[][] = [];
    private nextSpanId = SPAN_ID_BASE;

    public next(rows: TerminalRow[], timestamp: number): ReplayEvent[] {
        const previous = this.previous;
        if (previous == null || previous.length !== rows.length) {
            return [this.fullSnapshot(rows, timestamp)];
        }

        const removes: NodeRemoval[] = [];
        const adds: NodeAddition[] = [];
        rows.forEach((row, index) => {
            if (!rowChanged(previous[index], row)) return;
            const rowId = ROW_ID_BASE + index;
            for (const spanId of this.mountedSpanIds[index] ?? []) removes.push({ parentId: rowId, id: spanId });
            const spans = row.runs.map((run) => this.spanNode(run));
            // A mutation add is built with `skipChild: true`, so nested children are
            // dropped on the floor - each node has to arrive as its own add, parent
            // before child. (A full snapshot builds recursively, which is why
            // nesting works there and only there.)
            for (const span of spans) {
                adds.push({ parentId: rowId, nextId: null, node: { ...span, childNodes: [] } });
                for (const child of span.childNodes ?? []) {
                    adds.push({ parentId: span.id, nextId: null, node: child });
                }
            }
            this.mountedSpanIds[index] = spans.map((span) => span.id);
        });

        this.previous = rows;
        if (removes.length === 0 && adds.length === 0) return [];
        return [mutation(removes, adds, timestamp)];
    }

    /** Reset so the next frame re-emits a full snapshot (used on resume). */
    public invalidate(): void {
        this.previous = undefined;
    }

    private spanNode(run: StyledRun): SerializedNode {
        return {
            type: NODE_TYPE.element,
            tagName: "span",
            attributes: { style: run.css },
            id: this.nextSpanId++,
            childNodes: [{ type: NODE_TYPE.text, textContent: run.text, id: this.nextSpanId++ }],
        };
    }

    private fullSnapshot(rows: TerminalRow[], timestamp: number): FullSnapshotEvent {
        this.mountedSpanIds = [];
        const rowNodes = rows.map((row, index) => {
            const spans = row.runs.map((run) => this.spanNode(run));
            this.mountedSpanIds[index] = spans.map((span) => span.id);
            return {
                type: NODE_TYPE.element,
                tagName: "div",
                attributes: {},
                id: ROW_ID_BASE + index,
                childNodes: spans,
            };
        });
        this.previous = rows;

        return {
            type: 2,
            timestamp,
            data: { node: documentNode(rowNodes), initialOffset: { left: 0, top: 0 } },
        };
    }
}

function rowChanged(previous: TerminalRow | undefined, next: TerminalRow): boolean {
    if (previous == null || previous.runs.length !== next.runs.length) return true;
    return previous.runs.some((run, index) => {
        const candidate = next.runs[index];
        return candidate == null || run.text !== candidate.text || run.css !== candidate.css;
    });
}

function mutation(removes: NodeRemoval[], adds: NodeAddition[], timestamp: number): MutationEvent {
    return { type: 3, timestamp, data: { source: 0, texts: [], attributes: [], removes, adds } };
}

function documentNode(rowNodes: SerializedNode[]): SerializedNode {
    return {
        type: NODE_TYPE.document,
        id: DOCUMENT_ID,
        childNodes: [
            { type: NODE_TYPE.doctype, name: "html", publicId: "", systemId: "", id: DOCTYPE_ID },
            {
                type: NODE_TYPE.element,
                tagName: "html",
                attributes: {},
                id: HTML_ID,
                childNodes: [
                    {
                        type: NODE_TYPE.element,
                        tagName: "head",
                        attributes: {},
                        id: HEAD_ID,
                        childNodes: [
                            {
                                type: NODE_TYPE.element,
                                tagName: "style",
                                attributes: { _cssText: CSS },
                                id: STYLE_ID,
                                childNodes: [],
                            },
                        ],
                    },
                    {
                        type: NODE_TYPE.element,
                        tagName: "body",
                        attributes: {},
                        id: BODY_ID,
                        childNodes: [
                            {
                                type: NODE_TYPE.element,
                                tagName: "pre",
                                attributes: {},
                                id: PRE_ID,
                                childNodes: rowNodes,
                            },
                            {
                                type: NODE_TYPE.element,
                                tagName: "input",
                                attributes: { type: "text", value: "" },
                                id: KEY_TARGET_ID,
                                childNodes: [],
                            },
                        ],
                    },
                ],
            },
        ],
    };
}
