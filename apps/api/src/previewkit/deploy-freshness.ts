/** How long a preview goes untouched before "ready" stops being evidence that it is still serving. */
const STALE_DEPLOY_MS = 48 * 60 * 60 * 1000;

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * How much the recorded state of a preview can still be trusted, given how long
 * ago it was deployed.
 */
export interface DeployFreshness {
    /** When this environment last finished deploying. Absent when it never has. */
    deployedAt?: Date;
    /** Whole hours since that deploy, so a caller can weigh the status without parsing dates. */
    ageHours?: number;
    /** True when the deploy is old enough that a recorded "ready" may no longer describe a live preview. */
    stale: boolean;
    /** What the age means, when it means anything. */
    note?: string;
}

/**
 * Grades a preview's recorded state by the age of its last deploy.
 *
 * Deploy status is mirrored into the database by the deploy pipeline and then
 * never revisited, so an environment reaped or torn down out of band keeps
 * reporting whatever it last wrote - a "ready" that has been dead for weeks,
 * indistinguishable from one that is serving. Probing the URL on every read
 * would be the direct answer and is far too expensive for tools an agent calls
 * in a loop; the deploy's own age is free and separates the two cases well
 * enough to stop a caller asserting health it has not checked.
 *
 * Only a terminally-good state can be stale: a `failed` or `torn_down`
 * environment already tells the caller not to expect anything from it.
 */
export function deployFreshness(params: { status: string; deployedAt?: Date; now?: Date }): DeployFreshness {
    const { status, deployedAt } = params;
    const now = params.now ?? new Date();

    if (deployedAt == null) {
        return { stale: false, note: statusSuggestsServing(status) ? NEVER_DEPLOYED_NOTE : undefined };
    }

    const ageMs = now.getTime() - deployedAt.getTime();
    const ageHours = Math.floor(ageMs / MS_PER_HOUR);
    const stale = statusSuggestsServing(status) && ageMs >= STALE_DEPLOY_MS;
    return { deployedAt, ageHours, stale, note: stale ? staleNote(ageHours) : undefined };
}

/** Whether the recorded status is one a caller would read as "this preview is up". */
function statusSuggestsServing(status: string): boolean {
    return status === "ready";
}

const NEVER_DEPLOYED_NOTE =
    "This environment is recorded ready but has no completed deploy on record, so there is nothing behind the " +
    "status. Treat its URLs as unverified.";

function staleNote(ageHours: number): string {
    return (
        `This preview last deployed ${describeAge(ageHours)} ago. Autonoma tears previews down once it has finished ` +
        `testing, and the recorded status is not revisited afterwards, so "ready" here is what the last deploy ` +
        `wrote rather than proof the preview is still serving - a request to its URL may return 404 for an unknown ` +
        `host. That is different from a cold start (a scaled-to-zero preview answers 503 or hangs briefly while it ` +
        `wakes, then serves). Confirm with a request before telling the user the app is up, and redeploy if it is gone.`
    );
}

function describeAge(ageHours: number): string {
    if (ageHours < 48) return `${ageHours} hours`;
    return `${Math.floor(ageHours / 24)} days`;
}
