import type { ChildProcess, SpawnOptions } from "node:child_process";
import spawn from "cross-spawn";
import { debugLog } from "./debug";

// Node's message for a spawn it never got far enough to name a binary for. Anchored so
// only the whole prefix is rewritten, never an errno that happens to spell "spawn".
const UNNAMED_SPAWN_PREFIX = /^spawn\b/;

/** Whether a spawn produced a process, or failed before there was one to listen to. */
export type SpawnAttempt = { started: true; proc: ChildProcess } | { started: false; error: Error };

/**
 * Start a process, reporting a failure that happens before the process exists as a
 * value rather than an exception.
 *
 * Node reports a spawn failure asynchronously - as an `error` event on the returned
 * process - for exactly five errno codes: EACCES, EAGAIN, EMFILE, ENFILE and ENOENT
 * (`lib/internal/child_process.js`). Every other code is thrown straight out of
 * `spawn()`, before any listener can be attached to a return value that never arrives,
 * and cross-spawn passes that throw through untouched.
 *
 * ENOENT - the missing binary - is on the deferred list, which is why an `error`
 * listener alone looks sufficient right up until a machine refuses to execute a binary
 * that is installed and on PATH. EPERM (a Windows execution policy or an
 * endpoint-security agent refusing the cmd.exe shim cross-spawn rewrites the call into)
 * and ENOEXEC both arrive by the throwing path.
 *
 * The two paths also disagree about the message. Node names the binary only once it has
 * recorded one on the process object (`spawn claude EPERM`); the throw happens before
 * that and says `spawn EPERM`, which names nothing and so matches none of the patterns
 * that turn a spawn failure into a sentence someone can act on. Restating it in the
 * shape the deferred path would have produced is what lets one set of matchers read both.
 */
export function trySpawn(command: string, args: string[], options: SpawnOptions): SpawnAttempt {
    try {
        return { started: true, proc: spawn(command, args, options) };
    } catch (err) {
        const error = nameTheBinary(err, command);
        debugLog("Spawn threw before the process existed", { command, error });
        return { started: false, error };
    }
}

/** Restate an unnamed spawn failure as the named one the async path would have emitted. */
function nameTheBinary(err: unknown, command: string): Error {
    const original = err instanceof Error ? err : new Error(String(err));
    if (original.message.includes(command)) return original;

    return new Error(original.message.replace(UNNAMED_SPAWN_PREFIX, `spawn ${command}`), { cause: original });
}
