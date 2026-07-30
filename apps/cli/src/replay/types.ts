/**
 * The slice of the rrweb wire format the recorder emits.
 *
 * The dashboard has no DOM, so we synthesize one: a document whose body is a
 * single <pre> with one <div> per terminal row. That shape is what makes the
 * diffing in `frame-differ.ts` cheap - a repaint usually touches a handful of
 * rows, so only those rows' children are replaced.
 */

/** rrweb-snapshot NodeType. */
export const NODE_TYPE = {
    document: 0,
    doctype: 1,
    element: 2,
    text: 3,
} as const;

export interface SerializedNode {
    type: number;
    id: number;
    tagName?: string;
    attributes?: Record<string, string>;
    childNodes?: SerializedNode[];
    textContent?: string;
    name?: string;
    publicId?: string;
    systemId?: string;
}

export interface NodeRemoval {
    parentId: number;
    id: number;
}

export interface NodeAddition {
    parentId: number;
    /** null appends as the last child, which is how rows are rebuilt in order. */
    nextId: null;
    node: SerializedNode;
}

export interface MetaEvent {
    type: 4;
    timestamp: number;
    data: { href: string; width: number; height: number };
}

export interface FullSnapshotEvent {
    type: 2;
    timestamp: number;
    data: { node: SerializedNode; initialOffset: { left: number; top: number } };
}

export interface MutationEvent {
    type: 3;
    timestamp: number;
    data: {
        source: 0;
        texts: never[];
        attributes: never[];
        removes: NodeRemoval[];
        adds: NodeAddition[];
    };
}

/**
 * Source 5 (Input). PostHog derives `keypress_count` and the active/inactive
 * split from interaction events only - DOM mutations count for nothing - so
 * without these every recording reads as 100% idle and inactivity-skipping has
 * nothing to skip to.
 */
export interface UserInputEvent {
    type: 3;
    timestamp: number;
    data: { source: 5; id: number; text: string; isChecked: boolean };
}

export type ReplayEvent = MetaEvent | FullSnapshotEvent | MutationEvent | UserInputEvent;
