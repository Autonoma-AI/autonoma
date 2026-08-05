/**
 * Command-line flags, parsed once and asked by name.
 *
 * Written to be forgiving about spelling and strict about meaning, because the
 * caller is often an agent working from a copied command rather than a person with
 * `--help` open: `--key value` and `--key=value` are the same thing, a flag given
 * more than once keeps every value instead of the last, and a flag with several
 * accepted spellings answers to all of them.
 */
export class CliArgs {
    /** Absent value means the flag was given with no value at all. */
    private constructor(private readonly flags: ReadonlyMap<string, string[]>) {}

    static parse(argv: string[]): CliArgs {
        const flags = new Map<string, string[]>();

        for (let i = 0; i < argv.length; i++) {
            const arg = argv[i] ?? "";
            if (!arg.startsWith("--")) continue;

            const body = arg.slice(2);
            const equals = body.indexOf("=");
            if (equals !== -1) {
                push(flags, body.slice(0, equals), body.slice(equals + 1));
                continue;
            }

            // A value that looks like another flag is another flag: `--resume --project x`
            // has to read as two flags, not as `--resume` taking "--project".
            const next = argv[i + 1];
            if (next != null && next.length > 0 && !next.startsWith("--")) {
                push(flags, body, next);
                i++;
                continue;
            }
            push(flags, body, undefined);
        }

        return new CliArgs(flags);
    }

    /** Whether any of these spellings was given at all, with or without a value. */
    has(...names: string[]): boolean {
        return names.some((name) => this.flags.has(name));
    }

    /**
     * The value of the first of these spellings that carries one. A flag given with
     * no value has none - `--project` alone means the caller forgot the path, not
     * that the path is "true".
     */
    value(...names: string[]): string | undefined {
        for (const name of names) {
            const values = this.flags.get(name);
            if (values != null && values.length > 0) return values[values.length - 1];
        }
        return undefined;
    }

    /**
     * Every value given across these spellings, comma-separated lists expanded. So
     * `--backend api --backend db` and `--backends api,db` mean the same thing, and
     * neither has to be the one the caller happened to guess.
     *
     * Undefined when the flag was never given - which is different from given-empty,
     * because a caller who explicitly asked for no backends should get none rather
     * than the ones something else inferred.
     */
    list(...names: string[]): string[] | undefined {
        const given = names.flatMap((name) => this.flags.get(name) ?? []);
        if (!this.has(...names)) return undefined;
        return given
            .flatMap((value) => value.split(","))
            .map((value) => value.trim())
            .filter((value) => value.length > 0);
    }

    /**
     * Flags that are not in `known`, with the closest thing that is.
     *
     * A misspelled `--non-interactive` is the worst kind of typo here: nothing
     * refuses it, and the run instead waits on questions nobody will answer. Naming
     * it back turns a silent stall into one line of output.
     */
    unrecognized(known: ReadonlySet<string>): { given: string; meant?: string }[] {
        const found: { given: string; meant?: string }[] = [];
        for (const name of this.flags.keys()) {
            if (known.has(name)) continue;
            const meant = closestMatch(name, known);
            found.push(meant != null ? { given: name, meant } : { given: name });
        }
        return found;
    }
}

function push(flags: Map<string, string[]>, name: string, value: string | undefined): void {
    const existing = flags.get(name) ?? [];
    if (value != null) existing.push(value);
    flags.set(name, existing);
}

/** How different two flag names may be and still be a plausible typo for each other. */
const MAX_TYPO_DISTANCE = 3;

/** The known flag nearest `name`, when one is near enough to be worth suggesting. */
function closestMatch(name: string, known: ReadonlySet<string>): string | undefined {
    let best: string | undefined;
    let bestDistance = MAX_TYPO_DISTANCE + 1;

    for (const candidate of known) {
        const distance = editDistance(name, candidate);
        if (distance < bestDistance) {
            best = candidate;
            bestDistance = distance;
        }
    }

    return bestDistance <= MAX_TYPO_DISTANCE ? best : undefined;
}

/** Levenshtein distance, kept to two rows because the strings are flag names. */
function editDistance(a: string, b: string): number {
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        for (let j = 1; j <= b.length; j++) {
            const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
            const deletion = (previous[j] ?? 0) + 1;
            const insertion = (current[j - 1] ?? 0) + 1;
            current.push(Math.min(substitution, deletion, insertion));
        }
        previous = current;
    }

    return previous[b.length] ?? 0;
}
