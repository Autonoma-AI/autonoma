import { describe, expect, it } from "vitest";
import { applicationBranchRefs } from "../../../src/github/application-branch-refs";

describe("applicationBranchRefs", () => {
    it("follows the trunk when no deploy ref is pinned", () => {
        const refs = applicationBranchRefs({
            previewDeployRef: null,
            mainBranch: { name: "master" },
            mainBranchInfo: { githubRef: "master" },
        });

        expect(refs).toEqual({ trunk: "master", deploy: "master", deployTracksTrunk: true });
    });

    it("deploys the pinned ref without changing what the trunk is", () => {
        const refs = applicationBranchRefs({
            previewDeployRef: "autonoma-integration",
            mainBranch: { name: "master" },
            mainBranchInfo: { githubRef: "master" },
        });

        expect(refs).toEqual({ trunk: "master", deploy: "autonoma-integration", deployTracksTrunk: false });
    });

    it("still counts as following the trunk when the pinned ref IS the trunk", () => {
        // Drift detection keys off this. Reading "pinned to master" as "not following
        // the trunk" would silently switch staleness off for an app tracking its trunk.
        const refs = applicationBranchRefs({
            previewDeployRef: "master",
            mainBranch: { name: "master" },
            mainBranchInfo: { githubRef: "master" },
        });

        expect(refs).toEqual({ trunk: "master", deploy: "master", deployTracksTrunk: true });
    });

    it("reports no refs for an application with no branch record", () => {
        const refs = applicationBranchRefs({});

        expect(refs).toEqual({ trunk: undefined, deploy: undefined, deployTracksTrunk: true });
    });
});
