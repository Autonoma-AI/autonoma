import { InlineMp4VideoUploader, type UploadedVideo } from "@autonoma/ai";
import { type EvidenceLoader, StorageEvidenceLoader, summarizeSessionCost } from "@autonoma/diffs";
import { ClassifierAgent, type RunVerdict } from "@autonoma/diffs/analysis";
import { Evaluation, type LoadedCase, type RunCaseHelpers } from "@autonoma/evals";
import { logger as rootLogger } from "@autonoma/logger";
import { S3Storage } from "@autonoma/storage";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import { expect } from "vitest";
import {
    type CodebaseCoords,
    DiffsJudge,
    MissingEvidenceError,
    UnfetchableShaError,
    ensureCachedCheckout,
    probeEvidence,
} from "../framework";
import { type ClassifierFrontmatter, checkClassifierVerdict } from "./classifier-frontmatter";
import {
    type ClassifierCaseInput,
    type FrozenAppLogWindow,
    type FrozenRunMedia,
    rehydrateClassifierInput,
} from "./classifier-input";
import { createFrozenAppLogsLoader } from "./frozen-app-logs";

/** A loaded Classifier eval case: frozen classification input + authored expectations. */
export type ClassifierCase = LoadedCase<ClassifierCaseInput, ClassifierFrontmatter>;

/**
 * Per-case timeout. A classification is a tool loop over a real clone plus four full-recording vision reads,
 * and `runs: N` multiplies all of it, so the budget is per run rather than per case.
 */
const TIMEOUT_PER_RUN_MS = 900_000;

/**
 * Scored eval for the Investigator's classifier.
 *
 * Each case rehydrates the codebase from frozen coords, checks every storage key it references is still
 * downloadable, fetches the run's media, and runs {@link ClassifierAgent} directly - no workflow, no DB, no
 * writes. The prior-runs baseline is served from the frozen prose and `get_app_logs` from the frozen log window;
 * the recording is read live, so a replay grades the vision probes alongside the reasoning and touches nothing
 * but git, S3 and the models.
 *
 * `get_preview_env` and `get_app_logs` ARE served, from the name list and the log window frozen at capture - the
 * two live-infra capabilities that reduce to data. `run_script` does not: it is a query against a live backend,
 * and the classifier is told as much through its own evidence-limits note, so it caps unprovable claims rather
 * than guessing; each case records in `productionCapabilities` whether production had more to work with than
 * this replay does.
 *
 * A case passes when every classification satisfies the deterministic checks AND the judge passes. Cases whose
 * codebase or media can no longer be fetched are skipped, not failed.
 *
 * Runs sequentially: every case shares one on-disk working tree in the repo cache.
 */
export class ClassifierEvaluation extends Evaluation<ClassifierCase> {
    private readonly judge = new DiffsJudge();
    private readonly logger = rootLogger.child({ name: this.constructor.name });

    constructor(resultsDir: string, cases: ClassifierCase[]) {
        const slowestCase = cases.reduce((most, testCase) => Math.max(most, testCase.frontmatter.runs), 1);
        super(
            {
                name: "diffs-classifier",
                parallel: false,
                testOptions: { timeout: slowestCase * TIMEOUT_PER_RUN_MS },
                resultsDir,
            },
            cases,
        );
    }

    protected override caseName(testCase: ClassifierCase): string {
        const note = testCase.frontmatter.description;
        return note != null ? `${testCase.name} - ${note}` : testCase.name;
    }

    protected override testCaseInfo(testCase: ClassifierCase): Record<string, string> {
        const envNames = testCase.input.previewEnvNames;
        const appLogs = testCase.input.appLogs;
        return {
            case: testCase.name,
            repo: `${testCase.input.codebase.owner}/${testCase.input.codebase.repo}`,
            headSha: testCase.input.codebase.headSha,
            slug: testCase.input.test.slug,
            expectedCategory: testCase.frontmatter.category ?? "(unauthored)",
            capturedCategory: testCase.frontmatter.capturedCategory ?? "(unknown)",
            // Which tools production had that this replay does not, so a result file says outright when a case
            // is being graded against a classifier that could see less than the one it was captured from.
            productionOnlyTools: describeMissingTools(testCase.input),
            previewEnv: envNames != null ? `${envNames.length} names frozen` : "not frozen",
            appLogWindow: describeAppLogWindow(appLogs),
        };
    }

    protected override async runCase(
        testCase: ClassifierCase,
        addInfo: (info: Record<string, unknown>) => void,
        helpers: RunCaseHelpers,
    ): Promise<void> {
        if (testCase.frontmatter.skip === true) {
            helpers.skip("case marked skip: true in expected.md frontmatter");
        }

        const { coords, input, media, baseline, appLogs } = rehydrateClassifierInput(testCase.input);
        const codebase = await this.rehydrateCodebase(coords, helpers, testCase.name);

        const evidenceLoader = new StorageEvidenceLoader(S3Storage.createFromEnv());
        await this.probeReferencedEvidence(media, evidenceLoader, helpers, testCase.name);
        const finalScreenshot = await this.loadFinalScreenshot(media, evidenceLoader);

        // Imported here rather than at module scope: `services` pulls the worker's env, which demands the
        // GitHub App and OpenAI credentials at import time and would break the credential-free zero-case no-op.
        const { createModelSession } = await import("../../src/services");

        const verdicts: RunVerdict[] = [];
        const failuresByRun: string[] = [];
        const costs: ReturnType<typeof summarizeSessionCost>[] = [];

        for (let run = 1; run <= testCase.frontmatter.runs; run++) {
            const session = createModelSession();
            const videoModel = session.getVideoModel({ model: "smart-video", tag: "classifier-eval-video" });
            const recording = await this.loadRecording(media, evidenceLoader);
            const classifier = new ClassifierAgent({
                model: session.getModel({ model: "classifier", tag: "classifier-eval" }),
                videoModel: videoModel.model,
            });

            this.logger.info("Classifying eval case", {
                extra: { case: testCase.name, run, runs: testCase.frontmatter.runs },
            });

            const verdict = await this.classify(classifier, {
                ...input,
                run: { ...input.run, recording, finalScreenshot },
                codebase,
                screenshotLoader: evidenceLoader,
                loadBaseline: async () => baseline,
                // `previewEnv` rides in on `input` when the case froze one. `run_script` has no frozen form.
                previewScript: undefined,
                loadAppLogs: this.appLogsFor(appLogs, input.run),
            });
            verdicts.push(verdict);
            costs.push(summarizeSessionCost(session.costCollector));

            const failures = checkClassifierVerdict(verdict, testCase.frontmatter);
            if (failures.length > 0) {
                failuresByRun.push(`run ${run}: ${failures.map((f) => `${f.check}: ${f.message}`).join("; ")}`);
            }
        }

        // The full verdict of every run, not just a pass flag: diffing two result files is how a change is shown
        // to have moved the classifier.
        addInfo({
            categories: verdicts.map((verdict) => verdict.category),
            confidences: verdicts.map((verdict) => verdict.confidence),
            planFidelities: verdicts.map((verdict) => verdict.planFidelity),
            headlines: verdicts.map((verdict) => verdict.headline),
            evidenceCounts: verdicts.map((verdict) => verdict.evidence.length),
            deterministicFailures: failuresByRun,
            agentCosts: costs,
        });

        // Deterministic checks gate the (paid) judge call: a case that already fails enum-equality cannot pass.
        if (failuresByRun.length > 0) {
            expect.fail(`Deterministic checks failed: ${failuresByRun.join(" | ")}`);
        }

        // One judge call, on the first verdict. The rubric grades reasoning quality, which the deterministic
        // checks have already confirmed is consistent across every run of this case.
        const [judged] = verdicts;
        if (judged == null) expect.fail("No verdict was produced");

        const judgeVerdict = await this.judge.judge({ output: judged, rubric: testCase.rubric });
        addInfo({
            judgePassed: judgeVerdict.passed,
            judgeReasoning: judgeVerdict.reasoning,
            judgeCost: judgeVerdict.cost,
        });

        expect(judgeVerdict.passed, `Judge failed: ${judgeVerdict.reasoning}`).toBe(true);
    }

    /**
     * `get_app_logs`, served from the frozen window over the run's own epochs - the same window production's
     * loader was pointed at, since capture read those epochs off the run it froze.
     *
     * Returning `undefined` omits the tool entirely, which is what a case with no frozen window needs: the
     * classifier is then told it cannot read logs, rather than being handed an empty window it would state to
     * itself as "the app emitted no matching error".
     */
    private appLogsFor(
        window: FrozenAppLogWindow | undefined,
        run: { startEpoch: number; endEpoch: number },
    ): ((regex: string) => Promise<string>) | undefined {
        if (window == null) return undefined;
        return createFrozenAppLogsLoader({
            window,
            startEpoch: run.startEpoch,
            endEpoch: run.endEpoch,
            logger: this.logger,
        });
    }

    /**
     * Run one classification. A classifier that exhausts its steps or loses a tool fatally throws instead of
     * returning a verdict - in production the workflow contains that as a coverage fault, but for an eval it is
     * simply a case that produced nothing to grade.
     */
    private async classify(
        classifier: ClassifierAgent,
        input: Parameters<ClassifierAgent["run"]>[0],
    ): Promise<RunVerdict> {
        try {
            const { result } = await classifier.run(input);
            return result;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn("Classifier produced no verdict", { extra: { err: message } });
            expect.fail(`Classifier did not commit to a verdict: ${message}`);
        }
    }

    private async rehydrateCodebase(coords: CodebaseCoords, helpers: RunCaseHelpers, caseName: string) {
        try {
            return await ensureCachedCheckout(coords);
        } catch (err) {
            if (err instanceof UnfetchableShaError) {
                this.logger.warn("Skipping case: codebase no longer fetchable", {
                    extra: { case: caseName, sha: err.sha, repo: err.repoFullName },
                });
                helpers.skip(`codebase unfetchable: ${err.message}`);
            }
            throw err;
        }
    }

    /**
     * Verify every storage key the case references is still downloadable, before spending a single model call.
     * Step frames are deliberately included: the model drills into two or three of them and a dead key would
     * surface mid-run as a tool error the classifier would then reason about as if it were evidence.
     */
    private async probeReferencedEvidence(
        media: FrozenRunMedia,
        evidenceLoader: EvidenceLoader,
        helpers: RunCaseHelpers,
        caseName: string,
    ): Promise<void> {
        const screenshots: string[] = [];
        for (const step of media.inspectableSteps) {
            if (step.screenshotBeforeKey != null) screenshots.push(step.screenshotBeforeKey);
            if (step.screenshotAfterKey != null) screenshots.push(step.screenshotAfterKey);
        }

        const keys: Parameters<typeof probeEvidence>[0] = {
            screenshots,
            finalScreenshot: media.finalScreenshotKey,
            video: media.recording?.key,
        };

        try {
            await probeEvidence(keys, evidenceLoader);
        } catch (err) {
            if (err instanceof MissingEvidenceError) {
                this.logger.warn("Skipping case: evidence no longer reachable", {
                    extra: { case: caseName, key: err.key, kind: err.kind },
                });
                helpers.skip(`evidence unreachable: ${err.message}`);
            }
            throw err;
        }
    }

    private async loadFinalScreenshot(
        media: FrozenRunMedia,
        evidenceLoader: EvidenceLoader,
    ): Promise<Uint8Array | undefined> {
        if (media.finalScreenshotKey == null) return undefined;
        return new Uint8Array(await evidenceLoader.loadScreenshot(media.finalScreenshotKey));
    }

    /**
     * Fetch the recording and hand it to the vision models in the form they take.
     *
     * Re-uploaded per run rather than once per case: an uploaded video is a handle with its own lifetime at the
     * provider, and a `runs: N` case would otherwise be replaying a handle that may have expired mid-sweep.
     * The uploader is built with this host's ffmpeg for the same reason production builds its own - which
     * binary exists is not something the model registry can know.
     */
    private async loadRecording(
        media: FrozenRunMedia,
        evidenceLoader: EvidenceLoader,
    ): Promise<UploadedVideo | undefined> {
        const frozen = media.recording;
        if (frozen == null) return undefined;

        const bytes = await evidenceLoader.downloadVideo(frozen.key);
        const uploader = new InlineMp4VideoUploader(ffmpeg.path);
        return uploader.uploadVideo({
            data: { type: "buffer", buffer: Buffer.from(bytes).buffer },
            mimeType: frozen.isOptimizedMp4 ? "video/mp4" : "video/webm",
        });
    }
}

/**
 * The tools production had and this replay cannot serve, named for a result file.
 *
 * `get_preview_env` and `get_app_logs` count as missing only when the case carries no frozen name list / no
 * frozen window: a case captured with one offers the same tool over the same data, so listing it here would
 * report a gap that is not there.
 */
function describeMissingTools(input: ClassifierCaseInput): string {
    const capabilities = input.productionCapabilities;
    const missing: string[] = [];
    if (capabilities.previewEnv && input.previewEnvNames == null) missing.push("get_preview_env");
    if (capabilities.previewScript) missing.push("run_script");
    if (capabilities.appLogs && input.appLogs == null) missing.push("get_app_logs");
    return missing.length > 0 ? missing.join(", ") : "none";
}

/** How much log evidence the replay is serving, so a verdict resting on logs can be read against it. */
function describeAppLogWindow(appLogs: FrozenAppLogWindow | undefined): string {
    if (appLogs == null) return "not frozen";
    const truncation = appLogs.windowTruncated ? " (window hit its cap; older lines were not frozen)" : "";
    return `${appLogs.lines.length} lines${truncation}`;
}
