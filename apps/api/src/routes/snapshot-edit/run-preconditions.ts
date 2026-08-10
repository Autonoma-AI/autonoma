import { ApplicationArchitecture } from "@autonoma/db";
import { BadRequestError } from "@autonoma/errors";

/** The branch's active deployment, as far as "can a test of this application execute against it" is concerned. */
export interface BranchDeployment {
    webDeployment?: { url: string };
    mobileDeployment?: { deploymentId: string };
}

/** No deployment at all: the branch has nothing for a run to execute against. */
export class NoDeploymentConfiguredError extends BadRequestError {
    constructor() {
        super("No deployment configured for this branch. Configure a deployment in your application settings.");
        this.name = "NoDeploymentConfiguredError";
    }
}

/** A deployment exists, but not the kind this application's tests run on. */
export class WrongDeploymentKindError extends BadRequestError {
    constructor(architecture: ApplicationArchitecture) {
        const kind = architecture === ApplicationArchitecture.WEB ? "web" : "mobile";
        super(
            `Can't run ${kind} tests: no ${kind} deployment configured for this branch. ` +
                `Configure a ${kind} deployment in your application settings.`,
        );
        this.name = "WrongDeploymentKindError";
    }
}

/** The session was asked to run tests it does not hold - a stale client, or a test removed since it last read. */
export class TestsNotRunnableError extends BadRequestError {
    constructor(testCaseIds: string[]) {
        super(
            `${testCaseIds.length} of the requested tests are not part of this edit session, or have no plan to run. ` +
                "Reload the page and try again.",
        );
        this.name = "TestsNotRunnableError";
    }
}

/**
 * Refuse to start runs the branch cannot execute. Checked before any run is created rather than after, so a
 * misconfigured branch gets an actionable 400 instead of a column of failed runs the customer was charged for.
 */
export function assertBranchCanRun(architecture: ApplicationArchitecture, deployment?: BranchDeployment): void {
    if (deployment == null) throw new NoDeploymentConfiguredError();

    const target =
        architecture === ApplicationArchitecture.WEB ? deployment.webDeployment?.url : deployment.mobileDeployment;
    if (target == null || target === "") throw new WrongDeploymentKindError(architecture);
}
