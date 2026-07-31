import type { LanguageModel } from "ai";
import { captureLog } from "../../core/logs";
import { readDataContract, reviewOneTest, type SingleTestReview, type WrittenTest } from "./review";

/**
 * Reviews each test as soon as it is written, alongside generation.
 *
 * Review is the overwhelming majority of the step's wall clock, and it used to
 * start only once every node had been processed - so the whole cost sat on the
 * end. Nothing rewrites a test between being written and the first review pass,
 * so that pass has no reason to wait: a test handed over here is reviewed while
 * the generator is still reading the next node's source, and by the time
 * generation finishes most verdicts are already in.
 *
 * The generator passes the rendered test straight through, rather than a path to
 * read back: it just produced that content, and routing it via the filesystem
 * only creates a second place for the two sides to disagree about what a path
 * means. Only the FIRST pass is pipelined - the fix cycles that follow delete and
 * rewrite files, which cannot safely overlap a generator that is also writing,
 * so `drain()` is the barrier between the two.
 */

/** In-flight reviews. Each test costs one agent per rubric, so this is 4x in agents. */
const PIPELINE_CONCURRENCY = 4;

export class ReviewPipeline {
    private readonly inFlight = new Set<Promise<void>>();
    private readonly done: SingleTestReview[] = [];
    private readonly queue: WrittenTest[] = [];
    private readonly seen = new Set<string>();
    /** The contract is identical for every test, so it is read and rendered once. */
    private dataContract?: Promise<string | undefined>;
    private closed = false;

    constructor(
        private readonly outputDir: string,
        private readonly projectRoot: string,
        private readonly model: LanguageModel,
        private readonly deadline: number,
    ) {}

    /**
     * Hand a freshly written test over for review. Returns immediately - the
     * generator must never block on a reviewer.
     */
    public submit(test: WrittenTest): void {
        if (this.closed || this.seen.has(test.relativePath)) return;
        this.seen.add(test.relativePath);
        this.queue.push(test);
        this.pump();
    }

    private pump(): void {
        while (this.inFlight.size < PIPELINE_CONCURRENCY && this.queue.length > 0) {
            if (Date.now() > this.deadline) {
                this.queue.length = 0;
                return;
            }
            const test = this.queue.shift()!;
            this.dataContract ??= readDataContract(this.outputDir);

            const promise = this.dataContract
                .then((dataContract) =>
                    reviewOneTest({ projectRoot: this.projectRoot, model: this.model, test, dataContract }),
                )
                .then((review) => {
                    this.done.push(review);
                })
                .catch((err: unknown) => {
                    // A reviewer that dies must not take the generator with it -
                    // the test simply arrives unreviewed at the fix cycles.
                    captureLog("warn", `Pipelined review failed; the test will be reviewed in the fix cycles`, {
                        source: "review-pipeline",
                        path: test.relativePath,
                        error: err instanceof Error ? err.message : String(err),
                    });
                })
                .finally(() => {
                    this.inFlight.delete(promise);
                    this.pump();
                });
            this.inFlight.add(promise);
        }
    }

    /**
     * Stop accepting work and wait for what is running. Everything queued but not
     * started is dropped - the cycles that follow will pick those tests up, and
     * they are cheaper to review there than to hold generation open for.
     */
    public async drain(): Promise<SingleTestReview[]> {
        this.closed = true;
        this.queue.length = 0;
        await Promise.all(this.inFlight);
        return [...this.done];
    }
}
