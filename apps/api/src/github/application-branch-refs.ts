/**
 * The two branch refs an application has, resolved in one place.
 *
 * They are easy to confuse and were conflated for a long time, which is what let a
 * deploy-branch choice silently redefine an app's trunk:
 *
 * - **trunk** - the branch Autonoma treats as this app's mainline. Drives suite
 *   lineage, merge reconciliation, "problems on main", every "main" label. Set from
 *   the repository's default branch when the repo is linked.
 * - **deploy** - the ref the base preview (environment 0) builds. Usually the trunk;
 *   during onboarding it is the integration branch carrying preview config that has
 *   not merged yet.
 *
 * Ask this function rather than reaching for the fields, so a caller never has to
 * decide which of the two it meant - and so "does the base preview track the trunk"
 * is a named answer instead of a null check repeated at each site.
 */

/** Whatever an application row was selected with; every field is optional so any query shape fits. */
export interface ApplicationBranchRefSource {
    previewDeployRef?: string | null;
    mainBranch?: { name: string } | null;
    mainBranchInfo?: { githubRef: string } | null;
}

export interface ApplicationBranchRefs {
    /** What Autonoma calls this app's main branch. Undefined only for an app with no branch record. */
    trunk?: string;
    /** The ref environment 0 builds. Undefined when neither a deploy ref nor a trunk is known. */
    deploy?: string;
    /**
     * Whether the base preview follows the trunk. False means it is pinned somewhere
     * ELSE, so anything derived from the trunk - a snapshot sha, a branch label - does
     * not describe what is deployed.
     *
     * A ref pinned to the trunk's own name counts as following it. The two are the
     * same branch, and treating that as "pinned" would switch off drift detection for
     * an app that is tracking its trunk perfectly well.
     */
    deployTracksTrunk: boolean;
}

export function applicationBranchRefs(application: ApplicationBranchRefSource): ApplicationBranchRefs {
    const trunk = application.mainBranchInfo?.githubRef ?? application.mainBranch?.name ?? undefined;
    const pinned = application.previewDeployRef ?? undefined;
    return {
        trunk,
        deploy: pinned ?? trunk,
        deployTracksTrunk: pinned == null || pinned === trunk,
    };
}
