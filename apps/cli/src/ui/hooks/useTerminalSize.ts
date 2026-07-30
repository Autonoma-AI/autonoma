import { useEffect, useState } from "react";

const FALLBACK_COLUMNS = 100;
const FALLBACK_ROWS = 32;

export interface TermSize {
    columns: number;
    rows: number;
}

/** Terminal dimensions right now, for callers outside the React tree. */
export function currentTerminalSize(): TermSize {
    return {
        columns: process.stdout.columns || FALLBACK_COLUMNS,
        rows: process.stdout.rows || FALLBACK_ROWS,
    };
}

/** Reactive terminal dimensions; re-renders on resize. */
export function useTerminalSize(): TermSize {
    const [size, setSize] = useState<TermSize>(currentTerminalSize);
    useEffect(() => {
        const onResize = () => setSize(currentTerminalSize());
        process.stdout.on("resize", onResize);
        return () => {
            process.stdout.off("resize", onResize);
        };
    }, []);
    return size;
}
