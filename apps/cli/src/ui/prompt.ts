import type { PromptAnswer, PromptDraft, PromptRequest } from "./types";

/**
 * Pure editing logic for the docked prompt panel: how a fresh draft looks for
 * each prompt kind, how key actions mutate it, and how a draft becomes the
 * final answer on submit. The store owns the promise bridge; App routes keys.
 */

export type PromptAction =
    | { type: "up" }
    | { type: "down" }
    | { type: "setIndex"; index: number }
    | { type: "toggle" }
    | { type: "input"; text: string }
    | { type: "backspace" }
    | { type: "delete" }
    | { type: "left" }
    | { type: "right" }
    | { type: "home" }
    | { type: "end" };

export function initialDraft(req: PromptRequest): PromptDraft {
    switch (req.kind) {
        case "confirm":
            // Index 0 = yes, 1 = no.
            return { index: (req.initialValue ?? true) ? 0 : 1, text: "", cursor: 0, checked: [] };
        case "select": {
            const initial = req.options.findIndex((o) => o.value === req.initialValue);
            return { index: Math.max(0, initial), text: "", cursor: 0, checked: [] };
        }
        case "multiselect":
            return { index: 0, text: "", cursor: 0, checked: [...(req.initialValues ?? [])] };
        case "text": {
            const text = req.defaultValue ?? "";
            return { index: 0, text, cursor: text.length, checked: [] };
        }
    }
}

function clamp(n: number, max: number): number {
    return Math.max(0, Math.min(max, n));
}

export function promptReducer(req: PromptRequest, draft: PromptDraft, action: PromptAction): PromptDraft {
    // Any edit clears a previous submit error.
    const d: PromptDraft = { ...draft, error: undefined };

    switch (action.type) {
        case "up":
        case "down": {
            const delta = action.type === "up" ? -1 : 1;
            if (req.kind === "confirm") return { ...d, index: d.index === 0 ? 1 : 0 };
            if (req.kind === "select" || req.kind === "multiselect") {
                return { ...d, index: clamp(d.index + delta, req.options.length - 1) };
            }
            return d;
        }
        case "setIndex": {
            if (req.kind === "confirm") return { ...d, index: clamp(action.index, 1) };
            if (req.kind === "select" || req.kind === "multiselect") {
                return { ...d, index: clamp(action.index, req.options.length - 1) };
            }
            return d;
        }
        case "toggle": {
            if (req.kind !== "multiselect") return d;
            const value = req.options[d.index]?.value;
            if (value == null) return d;
            const checked = d.checked.includes(value) ? d.checked.filter((v) => v !== value) : [...d.checked, value];
            return { ...d, checked };
        }
        case "input": {
            if (req.kind !== "text") return d;
            const text = d.text.slice(0, d.cursor) + action.text + d.text.slice(d.cursor);
            return { ...d, text, cursor: d.cursor + action.text.length };
        }
        case "backspace": {
            if (req.kind !== "text" || d.cursor === 0) return d;
            return { ...d, text: d.text.slice(0, d.cursor - 1) + d.text.slice(d.cursor), cursor: d.cursor - 1 };
        }
        case "delete": {
            if (req.kind !== "text" || d.cursor >= d.text.length) return d;
            return { ...d, text: d.text.slice(0, d.cursor) + d.text.slice(d.cursor + 1) };
        }
        case "left":
            return req.kind === "text" ? { ...d, cursor: clamp(d.cursor - 1, d.text.length) } : d;
        case "right":
            return req.kind === "text" ? { ...d, cursor: clamp(d.cursor + 1, d.text.length) } : d;
        case "home":
            return req.kind === "text" ? { ...d, cursor: 0 } : d;
        case "end":
            return req.kind === "text" ? { ...d, cursor: d.text.length } : d;
    }
}

/**
 * Turn the draft into the submitted answer, or return an error string when
 * the draft can't be submitted yet (shown in the panel).
 */
export function answerFor(req: PromptRequest, draft: PromptDraft): PromptAnswer | { error: string } {
    switch (req.kind) {
        case "confirm":
            return { kind: "confirm", value: draft.index === 0 };
        case "select": {
            const option = req.options[draft.index];
            if (option == null) return { error: "Nothing selected" };
            return { kind: "select", value: option.value };
        }
        case "multiselect": {
            if (req.required !== false && draft.checked.length === 0) {
                return { error: "Select at least one (space toggles)" };
            }
            return { kind: "multiselect", values: draft.checked };
        }
        case "text":
            return { kind: "text", value: draft.text };
    }
}
