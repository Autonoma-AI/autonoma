import { getActiveStore } from "./store";
import type { LogLevel } from "./types";

/**
 * The pipeline's one interaction surface. With the TUI mounted, non-blocking
 * output (log/note/intro/outro) feeds the run store and blocking prompts
 * render as the docked ACTION REQUIRED panel via the store's prompt bridge.
 * Without a store (non-TTY, --non-interactive), output falls back to plain
 * console lines and blocking prompts resolve to their safe default - or
 * cancel when there is none - since there is nobody to ask.
 *
 * Cancellation is the CANCEL sentinel - check with isCancel().
 */

export const CANCEL: unique symbol = Symbol("prompt-cancelled");

export function isCancel(value: unknown): value is typeof CANCEL {
    return value === CANCEL;
}

const MARKERS: Record<LogLevel, string> = {
    info: "·",
    success: "✓",
    warn: "!",
    error: "✗",
    note: "·",
    checkpoint: "▸",
    intro: "◆",
    outro: "◆",
};

function emit(level: LogLevel, text: string, title?: string): void {
    const store = getActiveStore();
    if (store != null) {
        store.appendLog({ level, text, title });
        return;
    }
    const line = title != null ? `${title}\n${text}` : text;
    console.log(`${MARKERS[level]} ${line}`);
}

export const log = {
    info(message: string): void {
        emit("info", message);
    },
    success(message: string): void {
        emit("success", message);
    },
    step(message: string): void {
        emit("info", message);
    },
    warn(message: string): void {
        emit("warn", message);
    },
    error(message: string): void {
        emit("error", message);
    },
};

export function intro(message: string): void {
    emit("intro", message);
}

export function outro(message: string): void {
    emit("outro", message);
}

export function note(message: string, title?: string): void {
    emit("note", message, title);
}

/**
 * The opening welcome overlay, shown once before a fresh run. Resolves when the
 * user presses enter. Headless runs print the intro and continue.
 */
export async function welcome(opts: { title: string; lines: string[]; cta: string }): Promise<void> {
    const store = getActiveStore();
    if (store == null) {
        console.log(`◆ ${opts.title}\n${opts.lines.map((l) => `  ${l}`).join("\n")}`);
        return;
    }
    await store.runWelcome(opts);
}

/**
 * A blocking countdown overlay explaining what happens next; resolves when it
 * runs out or the user presses enter to continue immediately. Headless runs
 * print the explanation and continue - a delay with nobody watching is waste.
 */
export async function countdown(opts: { title: string; lines: string[]; seconds: number }): Promise<void> {
    const store = getActiveStore();
    if (store == null) {
        console.log(`◆ ${opts.title}\n${opts.lines.map((l) => `  ${l}`).join("\n")}`);
        return;
    }
    await store.runCountdown(opts);
}

/* ----------------------------------------------------------------- blocking -- */

export interface PromptExtras {
    /** Extra explainer line under the question. */
    detail?: string;
    /** Esc means "go back" and resolves CANCEL; off by default. */
    cancelable?: boolean;
}

export async function confirm(
    opts: { message: string; initialValue?: boolean } & PromptExtras,
): Promise<boolean | typeof CANCEL> {
    const store = getActiveStore();
    if (store == null) return opts.initialValue ?? true;
    const answer = await store.requestPrompt({
        kind: "confirm",
        message: opts.message,
        initialValue: opts.initialValue,
        detail: opts.detail,
        cancelable: opts.cancelable,
    });
    return answer.kind === "confirm" ? answer.value : CANCEL;
}

export async function text(
    opts: { message: string; placeholder?: string; defaultValue?: string; initialValue?: string } & PromptExtras,
): Promise<string | typeof CANCEL> {
    const store = getActiveStore();
    const defaultValue = opts.defaultValue ?? opts.initialValue;
    if (store == null) return defaultValue ?? CANCEL;
    const answer = await store.requestPrompt({
        kind: "text",
        message: opts.message,
        placeholder: opts.placeholder,
        defaultValue,
        detail: opts.detail,
        cancelable: opts.cancelable,
    });
    return answer.kind === "text" ? answer.value : CANCEL;
}

interface TypedOption<V extends string> {
    value: V;
    label: string;
    hint?: string;
}

export async function select<V extends string>(
    opts: { message: string; options: TypedOption<V>[]; initialValue?: V } & PromptExtras,
): Promise<V | typeof CANCEL> {
    const store = getActiveStore();
    if (store == null) return opts.initialValue ?? CANCEL;
    const answer = await store.requestPrompt({
        kind: "select",
        message: opts.message,
        options: opts.options,
        initialValue: opts.initialValue,
        detail: opts.detail,
        cancelable: opts.cancelable,
    });
    if (answer.kind !== "select") return CANCEL;
    const match = opts.options.find((o) => o.value === answer.value);
    return match != null ? match.value : CANCEL;
}

export async function multiselect<V extends string>(
    opts: { message: string; options: TypedOption<V>[]; initialValues?: V[]; required?: boolean } & PromptExtras,
): Promise<V[] | typeof CANCEL> {
    const store = getActiveStore();
    if (store == null) return opts.initialValues ?? CANCEL;
    const answer = await store.requestPrompt({
        kind: "multiselect",
        message: opts.message,
        options: opts.options,
        initialValues: opts.initialValues,
        required: opts.required,
        detail: opts.detail,
        cancelable: opts.cancelable,
    });
    if (answer.kind !== "multiselect") return CANCEL;
    const allowed = new Set<string>(opts.options.map((o) => o.value));
    return opts.options.map((o) => o.value).filter((v) => allowed.has(v) && answer.values.includes(v));
}
