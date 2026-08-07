import { basename, sep } from "node:path";

/** What the docs, the web app, and every copied command tell people to run. */
export const NPX_INVOCATION = "npx @autonoma-ai/planner@latest";

/** The bin name, which only exists on PATH after a deliberate global install. */
const BIN_NAME = "autonoma-planner";

/**
 * How to run this CLI again, spelled the way it was actually reached.
 *
 * Nearly everyone arrives through `npx @autonoma-ai/planner@latest`, which installs
 * nothing on PATH - so a hint that says `autonoma-planner --resume` is a command
 * they do not have, offered at the exact moment they need one that works.
 *
 * Three ways in, three spellings:
 * - a global install, where the bin name is genuinely on PATH;
 * - `npx`, which runs out of a throwaway cache directory;
 * - anything else (a local checkout, `pnpm dev`, a bundled path), where the script
 *   path is the only thing certain to work.
 */
export function selfInvocation(argv = process.argv, execPath = process.execPath): string {
    const scriptPath = argv[1];
    if (scriptPath == null || scriptPath === "") return NPX_INVOCATION;
    if (basename(scriptPath) === BIN_NAME) return BIN_NAME;
    if (isNpxCachePath(scriptPath)) return NPX_INVOCATION;
    return `${execPath} ${scriptPath}`;
}

/**
 * npx runs packages out of `_npx/<hash>/node_modules/...` under the npm cache. The
 * path is stable enough to recognise, and getting it wrong only costs a hint that is
 * longer than it needed to be.
 */
function isNpxCachePath(scriptPath: string): boolean {
    return scriptPath.split(sep).includes("_npx");
}
