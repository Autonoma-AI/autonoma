import { TextGenerator, type LanguageModel, type RetryConfig, type UploadedVideo } from "@autonoma/ai";
import { logger as rootLogger } from "@autonoma/logger";

/**
 * Bounded retry for the vision reads, tighter than the shared default.
 *
 * `buildRetry` treats a TIMEOUT as transient, so `maxRetries` multiplies the per-attempt ceiling: the default
 * policy would let one hung full-recording read spend 33 minutes, past the 30-minute Temporal
 * `startToCloseTimeout` that is the classifier's only wall clock.
 */
const VISION_RETRY: RetryConfig = { maxRetries: 3, initialDelayInMs: 1000, backoffFactor: 2, maxDelayInMs: 10_000 };

/** A full-recording read re-sends the whole video and has been measured from ~10s to well over a minute. */
const RECORDING_TIMEOUT_MS = 3 * 60_000;

/**
 * Prepended to every probe.
 *
 * The recording is the optimizer's output for ~99% of runs: resampled to 1 fps, with frames identical to
 * their neighbour dropped and the timeline recompressed, so its DURATION EQUALS ITS DISTINCT-FRAME COUNT.
 * Two things follow, and both have to be said. Adjacent frames are separate states rather than a held view,
 * so a screen that appears for one frame is a real screen and not a sampling artifact; and elapsed time in
 * this video has no relation to elapsed time in the run, so the probe must describe WHEN by what preceded
 * it, never by a clock the classifier would try to line up against the step trace.
 */
const VIDEO_SCAN_GUIDANCE =
    'This recording has been COMPRESSED: it was resampled and every stretch where the screen did not change was collapsed, so each frame is a DISTINCT state of the app and consecutive frames may be far apart in real time. Two consequences. (1) Do NOT treat a screen that appears only briefly as a glitch or a sampling artifact - it genuinely occurred, and every frame is worth accounting for. (2) The video\'s own timing is MEANINGLESS as run time: never report a timestamp, a duration, or how long something was on screen. When you need to say WHEN something happened, say it in terms of what came before it ("after the login form was submitted", "on the screen following the search"). Watch from the first frame to the last before answering.';

/**
 * A deterministic FIRST-PASS probe run over the video before the classifier reasons. It asks the vision
 * model one plain, specific question - enumerate every visible error state - so the error signal is always
 * surfaced as fact, instead of depending on the classifier choosing to ask the right question.
 */
const ERROR_PROBE_PROMPT = `You are scanning a screen recording of an automated test run for ERROR STATES. Do NOT summarize the run and do NOT judge whether the test passed. Your ONLY job is to enumerate, literally, every visible sign of something going wrong.

List EVERY occurrence of: an error toast / banner / snackbar, red error text, an inline form/validation error, a warning message, a "something went wrong" / generic-failure screen, a stack trace, an HTTP 4xx/5xx page, a blank/broken/half-rendered view, a spinner that never resolves, or an obviously-wrong or empty response where content was expected.

For EACH occurrence, give:
- the EXACT visible text (quote it), and
- roughly when in the run it appeared (e.g. "after the 2nd message was sent") and on which screen.

Be exhaustive - if the same error appears multiple times, report each. Quote text verbatim; do not paraphrase. If, after watching the entire recording, there are genuinely NO error states at any point, respond with exactly: NO VISIBLE ERRORS`;

/**
 * A deterministic FIRST-PASS probe: give the vision model the test's intended steps + the video and ask,
 * plainly, whether the run actually followed them or diverged. Makes planFidelity a measured fact (not an
 * inference) and guards against false positives - a diverged run never exercised the behavior under test.
 * The intended steps are appended after this prompt.
 */
const FIDELITY_PROBE_PROMPT = `You are checking whether an automated test run actually FOLLOWED its written steps. Do NOT judge whether the app is buggy - only compare what the steps INTENDED against what the recording SHOWS.

Watch the screen recording and report:
- For each intended step, whether it was actually performed as written (yes / partial / no) and what actually happened on screen at that point.
- Every DIVERGENCE: a different action than the step described, an unexpected screen or route, a step skipped or impossible because the UI did not match, or the run going off-script.

Then end with EXACTLY one final line:
FIDELITY: exact   (every step performed as written, against the UI the steps assume)
FIDELITY: partial (mostly followed, with minor divergences)
FIDELITY: diverged (the run did NOT exercise what the steps intended)

Be literal - do not assume a step succeeded just because the next one ran. The intended steps follow.`;

/**
 * The "human glance" probe - a GENERIC visual-quality sweep run on EVERY classification, independent of the
 * test's goal or outcome. It catches the class of problems a person spots instantly but a goal-directed run
 * walks right past (empty content, broken images, layout breakage). Deliberately app-agnostic: no app, page,
 * or feature names - just universal "what looks broken" categories - so it generalizes and surfaces issues
 * we never enumerated. Its findings are HINTS for the classifier to verify, never final verdicts.
 */
const VISUAL_SANITY_PROBE_PROMPT = `You are a meticulous QA reviewer watching a screen recording of a web app. IGNORE whether the test passed and IGNORE the test's goal. Your ONLY job: as a careful human would at a glance, flag anything that looks clearly WRONG or BROKEN about the APP ITSELF.

Report each occurrence, with WHERE it appears (page/area) and which point in the run it follows (name the preceding screen or action - do NOT give a timestamp):
- broken or missing images / icons / avatars / logos / thumbnails (placeholder or empty image frames)
- text overlapping OTHER elements, or spilling outside its box so it obscures adjacent content, or a fixed non-editable label/heading/button/cell truncated mid-content so meaning is LOST (no ellipsis, no scroll/expand). NOT a long value that simply scrolls inside a text input / textarea / select, NOT text intentionally cut with an ellipsis "...", NOT content inside a scrollable region: a field or box not showing its ENTIRE value is normal, not broken - only flag it when text visibly ESCAPES its box or is cut off with information lost.
- broken or misaligned layout: elements stacked on top of each other, off-screen, wrong z-index (an overlay behind content), components at the wrong size, large unexpected gaps
- content that did not load: blank regions, skeletons / spinners that never resolve, empty lists / tables / grids / maps / charts where data is clearly expected, "no results" / "nothing here" where there should be content
- obvious error or empty states, distorted or unstyled content, default browser styling where the app's own design should be

These are HINTS for a reviewer to verify, NOT final judgments - describe exactly what you see, do not conclude it is a bug. If the app looks visually healthy throughout, reply EXACTLY: "NOTHING OBVIOUSLY WRONG".`;

/**
 * The MISSION probe - the pass that answers the question the other three do not: did the test's intended
 * OUTCOMES actually happen (not just: were its steps clicked). A control that is clicked while its EFFECT never
 * occurs - a toggle that changes nothing, a value that should update but does not, a mode that should switch but
 * stays - passes the error/fidelity/visual scans and the weak literal assertions, and the classifier is left to
 * GUESS whether the feature worked. This probe removes the guess: it extracts each validation the test intends
 * and reports, per validation, whether it VISIBLY occurred - comparing before/after for every expected change.
 * The test's plan (Setup/Intent/Steps/Expected Result) is appended after this prompt.
 */
const MISSION_PROBE_PROMPT = `You are checking whether an automated test achieved its GOAL - the outcomes it set out to verify - NOT whether its steps were merely performed. A step can be carried out while its intended EFFECT never happens: an action that should change what is on screen leaves it unchanged, something that should update does not, a state the app should reach it never reaches. Your job is to catch exactly that.

From the test below, identify each VALIDATION it intends: its stated intent / expected result, plus every assertion or expected STATE CHANGE in its steps. Then watch the ENTIRE recording and, for EACH validation, judge whether it ACTUALLY occurred on screen.

Rules:
- Judge the OUTCOME as a user would experience it: did the result the test is verifying actually happen on screen? A step can be performed while its effect never lands - a control that changes nothing, a value that never updates, a state the app never reaches - and that is exactly what you exist to catch.
- Do not be fooled by a control's own movement: a switch sliding or a button depressing shows it was clicked, not that what it governs changed. Look at the region the action was meant to affect, not the widget.
- Give normal behavior its due: judge the SETTLED result over the whole recording, not one frame. A transient state that resolves on its own (a brief loading/empty flash, a value that hydrates in a beat late) is normal - achieved. An intended change that never happens ANYWHERE in the recording did not occur.
- Judge only what the test actually sets out to verify - do not invent expectations it never had. If the recording genuinely does not let you tell, say UNCLEAR.

For EACH validation, output ONE line:
- ACHIEVED: <validation> - <what you saw that confirms it>
- NOT ACHIEVED: <validation> - <what you saw instead, describing the before-vs-after of the relevant region>
- UNCLEAR: <validation> - <why>

Then end with EXACTLY one final line:
MISSION: achieved   (every validation the test intended actually occurred on screen)
MISSION: partial    (some occurred, some did not)
MISSION: not_achieved (the test's core intended outcome did not occur)

The test follows.`;

export interface VisionProbeRequest {
    /**
     * The run's recording. Non-optional by design: every probe asks a question only a recording can answer -
     * what appeared ACROSS the run - so a run without one gets no scans at all rather than four answers
     * derived from whatever else happened to be lying around.
     */
    recording: UploadedVideo;
    /** Reads the recording - the video-literate model. The probes are the reads that most need it. */
    reader: TextGenerator;
    /** The test's plan, appended to the fidelity and mission probes so each judges against what was intended. */
    testPlan: string;
}

/**
 * The four deterministic scans, in the order the prompt renders them.
 *
 * A field is `undefined` when that probe FAILED. It is not an empty string and not an error note, because
 * either would be rendered into a section that goes on to say "treat this as observed FACT" - a scan that did
 * not run must be able to suppress its own interpretation rather than be mistaken for its own answer.
 */
export interface ProbeScans {
    errorScan?: string;
    fidelityScan?: string;
    visualScan?: string;
    missionScan?: string;
}

/**
 * The deterministic vision pass over the run's recording - the "always ask plainly, then dig" pattern. All
 * four probes run BEFORE the classifier reasons, in parallel, so the signals it most often gets wrong
 * (on-screen errors, did-the-run-follow-the-plan, does the app look broken, did the intended outcomes occur)
 * are surfaced as fact instead of left to its discretion. They are deliberately NOT tools for exactly that
 * reason. A probe that fails yields `undefined` rather than failing the run - the prompt then says that scan
 * did not run, instead of presenting the failure as the scan's finding.
 */
export async function runVisionProbes({ recording, reader, testPlan }: VisionProbeRequest): Promise<ProbeScans> {
    const logger = rootLogger.child({ name: "runVisionProbes" });
    const probe = (prompt: string, label: string) => visionProbe({ recording, reader, prompt, label });

    const [errorScan, fidelityScan, visualScan, missionScan] = await Promise.all([
        probe(ERROR_PROBE_PROMPT, "error-probe"),
        probe(`${FIDELITY_PROBE_PROMPT}\n\nINTENDED STEPS:\n${testPlan}`, "fidelity-probe"),
        probe(VISUAL_SANITY_PROBE_PROMPT, "visual-sanity-probe"),
        probe(`${MISSION_PROBE_PROMPT}\n\nTEST:\n${testPlan}`, "mission-probe"),
    ]);

    const scans: ProbeScans = { errorScan, fidelityScan, visualScan, missionScan };
    logger.info("Probes complete", {
        extra: {
            failedProbes: Object.entries(scans)
                .filter(([, scan]) => scan == null)
                .map(([name]) => name),
            foundErrors: reportsFinding(errorScan, "NO VISIBLE ERRORS"),
            visualIssues: reportsFinding(visualScan, "NOTHING OBVIOUSLY WRONG"),
            fidelity: verdictLineOf(fidelityScan, "FIDELITY:"),
            mission: verdictLineOf(missionScan, "MISSION:"),
        },
    });
    return scans;
}

/**
 * The reader every recording read goes through - the probes here and the classifier's `analyze_video` alike.
 *
 * A read is an object you ask a question of, so which model answers and on what time budget is fixed by the
 * reader you hold, not chosen per call. Built here so the classifier and an offline scan capture share one
 * definition and cannot drift on the timeout/retry that keep a hung read inside the workflow's wall clock.
 */
export function createRecordingReader(videoModel: LanguageModel): TextGenerator {
    return new TextGenerator({ model: videoModel, timeoutMs: RECORDING_TIMEOUT_MS, retry: VISION_RETRY });
}

/**
 * Run the four probes over a recording with a freshly built reader - the standalone entry a caller uses to
 * reproduce, offline, the scans a classification would have read. Content depends only on the model and the
 * probe prompts, both fixed here, so a caller cannot freeze scans a classification could not have produced.
 */
export async function captureProbeScans(request: {
    videoModel: LanguageModel;
    recording: UploadedVideo;
    testPlan: string;
}): Promise<ProbeScans> {
    const reader = createRecordingReader(request.videoModel);
    return runVisionProbes({ recording: request.recording, reader, testPlan: request.testPlan });
}

interface SingleProbe extends Omit<VisionProbeRequest, "testPlan"> {
    prompt: string;
    label: string;
}

async function visionProbe({ recording, reader, prompt, label }: SingleProbe): Promise<string | undefined> {
    const logger = rootLogger.child({ name: "visionProbe" });
    logger.info("Running vision probe", { extra: { label } });
    try {
        const text = await reader.generate({
            userPrompt: `${VIDEO_SCAN_GUIDANCE}\n\n${prompt}`,
            video: recording,
        });
        return text.trim();
    } catch (error) {
        logger.warn("Vision probe failed; the prompt will say this scan did not run", {
            extra: { label },
            err: error,
        });
        return undefined;
    }
}

/**
 * Whether a scan actually reported something, for the log line only.
 *
 * The sentinel is compared after stripping quotes: the visual probe is told to reply `"NOTHING OBVIOUSLY
 * WRONG"` WITH the quote characters while the error probe is told to reply without them, so a bare
 * `startsWith` logged every compliant clean run as though it had found problems. A probe that did not run
 * reports nothing rather than a finding.
 */
function reportsFinding(scan: string | undefined, sentinel: string): boolean {
    if (scan == null) return false;
    return !scan.replaceAll('"', "").trimStart().startsWith(sentinel);
}

/** The probe's final verdict line (`FIDELITY: diverged`), for the log line. Absent if the probe did not run. */
function verdictLineOf(scan: string | undefined, marker: string): string | undefined {
    if (scan == null || !scan.includes(marker)) return undefined;
    return scan.split(marker).pop()?.trim().slice(0, 20);
}
