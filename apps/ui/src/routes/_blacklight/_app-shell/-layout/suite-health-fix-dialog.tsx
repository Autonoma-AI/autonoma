import { Button, Skeleton } from "@autonoma/blacklight";
import type { SuiteHealth, SuiteHealthFixKind, SuiteHealthFixPlan } from "@autonoma/types";
import { suiteHealthFixKindSchema } from "@autonoma/types";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { ConnectAgentDialog, DEBUG_MCP_DOCS_URL, DEBUG_MCP_SERVER_NAME } from "components/connect-agent-dialog";
import { useSuiteHealthFixPlan } from "lib/query/suite-health.queries";
import { Suspense, useState } from "react";
import { SUITE_HEALTH_PRESENTATION } from "./suite-health-copy";

const KIND_LABEL: Record<SuiteHealthFixKind, string> = {
  bug: "bug",
  environment: "environment",
  scenario: "test data",
};

interface FixDialogProps {
  health: SuiteHealth;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * "Put the suite back in order": hand every unresolved failure to a coding agent in one prompt.
 *
 * Built on the shared {@link ConnectAgentDialog} rather than as a dialog of its own. Connecting an agent is the
 * same work everywhere - install, authorize, then talk to it - and the authorize part in particular is the one
 * people skip and then report the tools as broken. A second hand-rolled version of it would drift from this one,
 * and the per-client install snippets would have to be maintained twice.
 *
 * All this surface adds is what to say once connected: the prompt, behind one button.
 */
export function SuiteHealthFixDialog({ health, open, onOpenChange }: FixDialogProps) {
  return (
    <FixDialogShell health={health} open={open} onOpenChange={onOpenChange}>
      <Suspense fallback={<CopyPromptSkeleton />}>
        <CopyPromptStep />
      </Suspense>
    </FixDialogShell>
  );
}

/**
 * The same dialog over a plan handed in rather than fetched, so a story can render every state with no router and
 * no network - the fetching version reads the current application out of route context, which exists only inside
 * the real route tree.
 */
export function SuiteHealthFixDialogPreview({
  health,
  plan,
  open,
  onOpenChange,
}: FixDialogProps & { plan: SuiteHealthFixPlan }) {
  return (
    <FixDialogShell health={health} open={open} onOpenChange={onOpenChange}>
      <CopyPrompt plan={plan} />
    </FixDialogShell>
  );
}

function FixDialogShell({ health, open, onOpenChange, children }: FixDialogProps & { children: React.ReactNode }) {
  const { label } = SUITE_HEALTH_PRESENTATION[health.level];

  return (
    <ConnectAgentDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Put the suite back in order"
      description={`Suite health is ${label} (${health.rank}/5). Hand the unresolved failures to your coding agent - it reads each one through the Autonoma MCP and fixes it wherever the fix lives.`}
      serverName={DEBUG_MCP_SERVER_NAME}
      endpoint="debug"
      docsUrl={DEBUG_MCP_DOCS_URL}
      // The real prompt here runs to a few hundred words naming every affected pull
      // request, so it stays behind the copy button rather than being inlined into a
      // launch command nobody could read. The short sentence gets the agent started;
      // the plan is what the user pastes next.
      prompt={`use the ${DEBUG_MCP_SERVER_NAME} MCP to fix my suite health`}
      capabilities={children}
    />
  );
}

function CopyPromptStep() {
  const { data: plan } = useSuiteHealthFixPlan();
  return <CopyPrompt plan={plan} />;
}

/**
 * The prompt, behind one button rather than printed in full. It runs to a few hundred words naming every affected
 * pull request, and nobody reads that before pasting it - showing it only pushed the button below the fold.
 */
function CopyPrompt({ plan }: { plan: SuiteHealthFixPlan }) {
  const [copied, setCopied] = useState(false);

  if (plan.totalIssues === 0) {
    return (
      <>
        Nothing is waiting on a decision right now, so there is no backlog to hand over. Suite health climbs on its own
        as more pull requests run.
      </>
    );
  }

  function copy() {
    void navigator.clipboard.writeText(plan.prompt).then(() => setCopied(true));
  }

  return (
    <>
      Then paste this into your agent. It describes {describeFindings(plan)} and tells the agent where each fix lives -
      only one of the three kinds is a change to your code.
      {/* `flex w-fit` over the variant's `inline-flex`: the step renders its content inside a paragraph, and an
          inline button lands mid-sentence at whatever point the text happens to wrap. */}
      <Button
        variant="accent"
        size="sm"
        onClick={copy}
        className="mt-3 flex w-fit gap-1.5 font-mono text-3xs font-bold uppercase tracking-wider"
      >
        {copied ? <CheckIcon weight="bold" /> : <CopyIcon weight="bold" />}
        {copied ? "Copied" : "Copy prompt"}
      </Button>
    </>
  );
}

function CopyPromptSkeleton() {
  return (
    <>
      <Skeleton className="h-3 w-full" />
      <Skeleton className="mt-3 h-7 w-32" />
    </>
  );
}

/** "17 unresolved findings (8 environment, 7 test data, 2 bug)", with the cap surfaced when the scan hit it. */
function describeFindings(plan: SuiteHealthFixPlan): string {
  // Derived from the schema, never hand-listed: a fourth kind must show up here the day it is added.
  const present = suiteHealthFixKindSchema.options
    .filter((kind) => plan.byKind[kind] > 0)
    .sort((a, b) => plan.byKind[b] - plan.byKind[a]);

  const count = `${plan.truncated ? "at least " : ""}${plan.totalIssues} unresolved ${
    plan.totalIssues === 1 ? "finding" : "findings"
  }`;
  if (present.length === 0) return count;

  return `${count} (${present.map((kind) => `${plan.byKind[kind]} ${KIND_LABEL[kind]}`).join(", ")})`;
}
