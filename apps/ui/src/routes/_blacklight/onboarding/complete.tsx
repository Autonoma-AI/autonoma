import { Button, Skeleton, cn } from "@autonoma/blacklight";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { EyeIcon } from "@phosphor-icons/react/Eye";
import { GithubLogoIcon } from "@phosphor-icons/react/GithubLogo";
import { XIcon } from "@phosphor-icons/react/X";
import { Link, Navigate, createFileRoute } from "@tanstack/react-router";
import { SuiteHealthBars, SuiteHealthPill } from "components/suite-health/suite-health-meter";
import { copyText } from "lib/clipboard";
import { CLAUDE_MD_LINE, CLAUDE_MD_LINE_SHORT } from "lib/onboarding/claude-md-line";
import { buildOnboardingSearch } from "lib/onboarding/onboarding-search";
import { useArtifactStatus } from "lib/query/app-generations.queries";
import { useSuiteHealthFor } from "lib/query/app-shell.queries";
import { useApplications } from "lib/query/applications.queries";
import { useApplicationRepositoryFromGitHub } from "lib/query/github.queries";
import { suiteHealthFooter, suiteHealthStats, SUITE_HEALTH_PRESENTATION } from "lib/suite-health/copy";
import { toastManager } from "lib/toast-manager";
import { type ReactNode, Suspense, useEffect, useState } from "react";
import { setLastAppId } from "../_app-shell/-last-app";

/**
 * The two controls are taller and quieter than the library's default: 40px against
 * 32px, sentence-case at text-sm rather than the mono uppercase this app uses for
 * dense toolbars. This screen has two controls on it and nothing else competing, so
 * they are sized for that rather than for a crowded row.
 */
const HANDOFF_BUTTON = "h-10 gap-2 text-sm font-semibold";

export const Route = createFileRoute("/_blacklight/onboarding/complete")({
  component: () => <Navigate to="/onboarding" search={buildOnboardingSearch("complete")} />,
});

/**
 * The end of onboarding, and the only screen that says so.
 *
 * It used to sit right after go-live, which made it a lie: the app was live but
 * could not provision test data yet, and it sent people on to a separate page
 * almost nobody came back to. It is now reached only once every step is done.
 *
 * The job of this screen is to point attention OUT of the dashboard. Home is a list
 * of pull requests and empty metrics, so landing there reads as "I must be supposed
 * to do something in here" when the answer is that the product's value happens on
 * the user's next pull request. So this says the work moves to GitHub, shows what
 * the finding will look like when it arrives, and offers the one action worth taking
 * now: putting the instruction into the repo they are about to work in. The exit is
 * offered after that action, not instead of it.
 */
export function CompletePage({ appId }: { appId?: string }) {
  return (
    <Suspense fallback={<CompletePageSkeleton />}>
      <CompletePageContent appId={appId} />
    </Suspense>
  );
}

function CompletePageSkeleton() {
  return (
    <div className="grid w-full border border-border-dim lg:grid-cols-2">
      <div className="flex flex-col gap-5 border-b border-border-dim px-8 py-10 lg:border-b-0 lg:border-r lg:px-11 lg:py-14">
        <Skeleton className="h-4 w-44" />
        <Skeleton className="h-24 w-full max-w-md" />
        <Skeleton className="h-16 w-full max-w-md" />
        <Skeleton className="h-11 w-72" />
      </div>
      <div className="bg-surface-base/60 px-8 py-10 lg:px-9 lg:py-9">
        <Skeleton className="h-96 w-full" />
      </div>
    </div>
  );
}

function CompletePageContent({ appId }: { appId?: string }) {
  const { data: applications } = useApplications();
  const application = applications.find((app) => app.id === appId);

  useEffect(() => {
    if (application != null) setLastAppId(application.id);
  }, [application]);

  return (
    <div className="grid w-full border border-border-dim bg-surface-void lg:grid-cols-2">
      <div className="flex flex-col justify-center border-b border-border-dim px-8 py-10 lg:border-b-0 lg:border-r lg:px-11 lg:py-14">
        <HandoffColumn appId={appId} appSlug={application?.slug} />
      </div>

      <div className="flex flex-col justify-center gap-3 bg-surface-base/60 px-8 py-10 lg:px-9 lg:py-9">
        <div className="flex items-center gap-2">
          <GithubLogoIcon size={13} weight="fill" className="text-text-primary" />
          <span className="font-mono text-4xs uppercase tracking-widest text-text-secondary">
            What you'll see on your next pull request
          </span>
        </div>
        <ExamplePullRequest />
        <ClaudeCodePanel />
        {appId != null && (
          <Suspense fallback={<Skeleton className="h-32 w-full" />}>
            <SuiteHealthPanel appId={appId} />
          </Suspense>
        )}
      </div>
    </div>
  );
}

// ─── Left: the handoff ────────────────────────────────────────────────────────

function HandoffColumn({ appId, appSlug }: { appId?: string; appSlug?: string }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  async function handleCopy() {
    const didCopy = await copyText(CLAUDE_MD_LINE);
    if (!didCopy) {
      // The whole screen hinges on this one action, so a clipboard we cannot reach
      // has to hand the line over some other way rather than leaving a dead button.
      setCopyFailed(true);
      toastManager.add({
        type: "critical",
        title: "Couldn't reach your clipboard",
        description: "The line is shown below - select it and copy it by hand.",
      });
      return;
    }
    setCopied(true);
    toastManager.add({
      type: "success",
      title: "Copied",
      description: "Paste it into your repository's CLAUDE.md.",
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2.5">
        <span className="size-1.5 animate-pulse bg-primary-ink" />
        <span className="font-mono text-4xs font-semibold uppercase tracking-widest text-primary-ink">
          Onboarding complete
        </span>
      </div>

      <h1 className="text-4xl font-semibold leading-tight tracking-tight text-text-primary">
        You're done here.
        <br />
        Go back to coding.
      </h1>

      <RepositoryLine appId={appId} />

      <ReadyFacts appId={appId} />

      <HandoffActions copied={copied} appSlug={appSlug} onCopy={() => void handleCopy()} />

      {copyFailed && (
        <p className="max-w-md select-all border border-border-dim bg-surface-base px-3 py-2.5 font-mono text-2xs leading-relaxed text-text-secondary">
          {CLAUDE_MD_LINE}
        </p>
      )}
    </div>
  );
}

interface HandoffActionsProps {
  copied: boolean;
  appSlug?: string;
  onCopy: () => void;
}

/**
 * The two arrangements of the exit.
 *
 * Before the copy, the CLAUDE.md line is the only primary and leaving is the quiet
 * option: it is the one thing that makes the review loop automatic, and it costs a
 * click. After it, that button has nothing left to do, so leaving is promoted -
 * the exit is offered once the useful action is done rather than competing with it.
 *
 * Stateless and exported so both arrangements can be rendered directly. The real
 * flip needs a clipboard write, which a headless browser will not grant, so a story
 * that had to click its way here could only ever photograph the failure path.
 */
export function HandoffActions({ copied, appSlug, onCopy }: HandoffActionsProps) {
  const goToDashboard = appSlug != null ? <Link to="/app/$appSlug" params={{ appSlug }} /> : <Link to="/" />;

  return (
    <div className="flex flex-wrap items-center gap-2.5 pt-1.5">
      {copied ? (
        <>
          <span className="inline-flex h-10 items-center gap-2 border border-primary-ink/35 px-4.5 text-sm text-primary-ink">
            <CheckIcon size={14} weight="fill" />
            Copied - paste it into CLAUDE.md
          </span>
          <Button variant="accent" className={cn(HANDOFF_BUTTON, "px-5")} render={goToDashboard}>
            Go to dashboard
          </Button>
        </>
      ) : (
        <>
          <Button variant="accent" className={cn(HANDOFF_BUTTON, "px-5")} onClick={onCopy}>
            <CopyIcon size={14} />
            Copy the CLAUDE.md line
          </Button>
          <Button variant="outline" className={cn(HANDOFF_BUTTON, "px-4.5 font-normal")} render={goToDashboard}>
            Go to dashboard
          </Button>
        </>
      )}
    </div>
  );
}

/**
 * The wiring, stated as fact rather than instruction: the repo Autonoma is attached
 * to, and that it already has what it needs there. Falls back to prose without the
 * repo card when GitHub has not answered - the sentence still reads.
 */
function RepositoryLine({ appId }: { appId?: string }) {
  const repositoryQuery = useApplicationRepositoryFromGitHub(appId ?? "");
  const repoFullName = repositoryQuery.data?.fullName;

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-md text-sm leading-relaxed text-text-secondary">
        Autonoma is attached to{" "}
        {repoFullName != null ? (
          <span className="font-mono text-xs text-primary-ink">{repoFullName}</span>
        ) : (
          "your repository"
        )}
        . There is nothing to check yet. The next pull request you open is what starts it, and its findings come back to
        you as review comments on that pull request.
      </p>

      {repoFullName != null && (
        <div className="flex w-fit items-center gap-2.5 border border-border-dim bg-surface-base px-3 py-2.5">
          <GithubLogoIcon size={18} weight="fill" className="text-text-primary" />
          <span className="flex flex-col gap-0.5">
            <span className="font-mono text-2xs text-text-primary">github.com/{repoFullName}</span>
            <span className="font-mono text-4xs uppercase tracking-widest text-text-secondary">
              autonoma[bot] · write access · checks enabled
            </span>
          </span>
          <span className="ml-1.5 size-1.5 bg-status-success" />
        </div>
      )}
    </div>
  );
}

/**
 * Three facts about what is now true, the first counted from what actually landed.
 * The planner's own tally rather than a round number: this screen is the last thing
 * standing between the user and their next PR, and a made-up count is the kind of
 * detail they check.
 */
function ReadyFacts({ appId }: { appId?: string }) {
  return (
    <div className="flex flex-col gap-1.5 border-l border-border-dim pl-3.5 font-mono text-2xs text-text-secondary">
      <Suspense fallback={<Fact>Tests generated from your first pass</Fact>}>
        {appId != null ? <GeneratedTestsFact appId={appId} /> : <Fact>Tests generated from your first pass</Fact>}
      </Suspense>
      <Fact>
        Every pull request gets an <span className="text-text-primary">autonoma / e2e</span> check
      </Fact>
      <Fact>Findings arrive as review comments, not email</Fact>
    </div>
  );
}

/** One fact, with the marker that makes the group read as a list rather than a paragraph. */
function Fact({ children }: { children: ReactNode }) {
  return (
    <span className="flex gap-1.5">
      <span aria-hidden className="text-border-mid">
        ▸
      </span>
      <span>{children}</span>
    </span>
  );
}

function GeneratedTestsFact({ appId }: { appId: string }) {
  const { data: artifactStatus } = useArtifactStatus(appId);
  const testsMeta = artifactStatus.artifacts.find((artifact) => artifact.key === "tests")?.meta;

  return <Fact>{testsMeta != null ? `${testsMeta} of tests generated` : "Tests generated"} from your first pass</Fact>;
}

// ─── Right: what the finding looks like ───────────────────────────────────────

/**
 * A worked example of the review comment, drawn from a fictional repository on
 * purpose. It is the one thing on this screen the user has not seen yet, and the
 * point is recognition tomorrow rather than information now - so it is labelled as
 * an example and never borrows the user's own repo name, which would read as a real
 * pull request they had somehow missed.
 *
 * The finding is described the way the agent describes one - what went wrong, in
 * human terms - not as an assertion diff. The runs are not deterministic, and a
 * fabricated `expected 3, received 0` would misrepresent what actually arrives.
 */
function ExamplePullRequest() {
  return (
    <div className="border border-border-dim bg-surface-base">
      <div className="flex items-center gap-2 border-b border-border-dim px-3.5 py-2.5">
        <span className="font-mono text-4xs uppercase tracking-widest text-text-secondary">Example</span>
        <span className="font-mono text-3xs text-text-secondary">acme/web #4821 · Add push-token rotation</span>
      </div>

      <div className="flex items-center gap-2.5 border-b border-border-dim bg-surface-raised px-3.5 py-2.5">
        <span className="grid size-3.5 place-items-center bg-status-critical/10">
          <XIcon size={9} weight="bold" className="text-status-critical" />
        </span>
        <span className="font-mono text-3xs text-text-primary">autonoma / e2e</span>
        <span className="flex-1 font-mono text-3xs text-text-secondary">1 failing, 11 passed</span>
        <span className="font-mono text-3xs text-primary-ink">Details</span>
      </div>

      <div className="flex gap-2.5 px-3.5 py-3">
        <span className="grid size-5 shrink-0 place-items-center bg-primary-ink">
          <EyeIcon size={12} weight="fill" className="text-surface-void" />
        </span>
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-3xs text-text-primary">autonoma[bot]</span>
            <span className="border border-border-dim px-1.5 py-0.5 font-mono text-4xs uppercase tracking-wide text-text-secondary">
              Bot
            </span>
            <span className="font-mono text-3xs text-text-secondary">reviewed</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="bg-status-critical/10 px-1.5 py-0.5 font-mono text-4xs font-semibold uppercase tracking-wide text-status-critical">
              Failed
            </span>
            <span className="font-mono text-2xs text-text-primary">add-to-cart</span>
          </div>
          <p className="text-xs leading-relaxed text-text-secondary">
            Adding a single item from the product page puts <span className="text-text-primary">two</span> of it in the
            cart. Happens on every attempt, only when the item is already in the cart.
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Chip>screenshot</Chip>
            <Chip>9 steps</Chip>
            <Chip accent>view evidence on Autonoma</Chip>
          </div>
        </div>
      </div>
    </div>
  );
}

function Chip({ children, accent = false }: { children: string; accent?: boolean }) {
  return (
    <span
      className={cn(
        "border px-1.5 py-0.5 font-mono text-4xs",
        accent ? "border-primary-ink/35 text-primary-ink" : "border-border-dim text-text-secondary",
      )}
    >
      {children}
    </span>
  );
}

/**
 * The instruction, shown where it will run. The MCP is already connected - the user
 * onboarded through it - so this is not an install snippet; it is the line worth
 * keeping, and the transcript underneath is what keeping it buys.
 */
function ClaudeCodePanel() {
  return (
    <div className="border border-border-dim bg-surface-base">
      <div className="flex items-center gap-2 border-b border-border-dim px-3.5 py-2">
        <span className="flex gap-1">
          <span className="size-1.5 bg-border-mid" />
          <span className="size-1.5 bg-border-mid" />
          <span className="size-1.5 bg-border-mid" />
        </span>
        <span className="font-mono text-4xs uppercase tracking-widest text-text-secondary">
          Your coding agent · autonoma MCP already connected
        </span>
      </div>
      <div className="flex flex-col gap-2 px-3.5 py-3">
        <span className="font-mono text-3xs text-text-secondary">CLAUDE.md · so it happens without you asking</span>
        <p className="font-mono text-2xs leading-relaxed text-text-primary">
          <span className="text-primary-ink">&gt; </span>
          {CLAUDE_MD_LINE_SHORT}
        </p>
        <div className="flex flex-col gap-0.5 border-l border-border-dim pl-2.5 font-mono text-3xs leading-relaxed text-text-secondary">
          <span>waiting for autonoma on this PR...</span>
          <span>1 failing test · add-to-cart</span>
          <span>pulled 9 steps and screenshots</span>
          <span className="text-primary-ink">
            Autonoma caught this: the add handler fires twice when the item is already in the cart. Patching useCart.ts
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Suite health in its own words, so the first failing check is read as "the suite is
 * still proving itself" rather than "this product is broken". Live rather than an
 * illustration: the level, its explanation and the footer are all derived, so a
 * suite that has genuinely run says so instead of being told it is new.
 */
function SuiteHealthPanel({ appId }: { appId: string }) {
  const { data: health } = useSuiteHealthFor(appId);
  const { body } = SUITE_HEALTH_PRESENTATION[health.level];

  return (
    <div className="flex flex-col gap-2 border border-border-dim bg-surface-base px-3.5 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-4xs font-semibold uppercase tracking-widest text-text-secondary">
          Suite health
        </span>
        <SuiteHealthPill health={health} />
      </div>
      <div className="flex items-end gap-2">
        <SuiteHealthBars health={health} />
        <span className="flex-1" />
        <span className="font-mono text-3xs text-text-secondary">{health.rank}/5</span>
      </div>
      <span className="font-mono text-3xs text-text-secondary">{suiteHealthStats(health)}</span>
      <p className="text-xs leading-relaxed text-text-secondary">{body}</p>
      <span className="border-t border-border-dim pt-2 font-mono text-4xs uppercase tracking-widest text-text-secondary">
        {suiteHealthFooter(health)}
      </span>
    </div>
  );
}
