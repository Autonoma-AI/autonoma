import { Badge, Button, cn, Input, Panel, PanelBody, Separator, Skeleton, Switch } from "@autonoma/blacklight";
import { AnalysisTriggerLabelSchema } from "@autonoma/types";
import { ChatCircleIcon } from "@phosphor-icons/react/ChatCircle";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { CursorClickIcon } from "@phosphor-icons/react/CursorClick";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { InfoIcon } from "@phosphor-icons/react/Info";
import type { Icon } from "@phosphor-icons/react/lib";
import { PlugsConnectedIcon } from "@phosphor-icons/react/PlugsConnected";
import { TagIcon } from "@phosphor-icons/react/Tag";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { RouteErrorState } from "components/route-error-state";
import { ensureAPIQueryData } from "lib/query/api-queries";
import { useTriggerConfig, useUpdateTriggerConfig } from "lib/query/github.queries";
import { trpc } from "lib/trpc";
import { Suspense, useState } from "react";
import { isSettingsEntryVisible, toSettingsVisibility } from "../-settings-rail";
import { useCurrentApplication } from "../../../-use-current-application";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/settings/triggers/")({
  // The rail hides this entry behind the same predicate. Typing the URL in directly has to be refused too,
  // so both gates read from one definition rather than each restating what the merge gate means.
  loader: async ({ context, params: { appSlug } }) => {
    const activeOrg = await ensureAPIQueryData(context.queryClient, trpc.auth.activeOrg.queryOptions());
    if (!isSettingsEntryVisible("triggers", toSettingsVisibility(activeOrg))) {
      throw redirect({ to: "/app/$appSlug/settings", params: { appSlug } });
    }
  },
  // The loader resolves the active org before this destination will render at all. Without a pending
  // component that wait paints nothing; the rail keeps rendering either way, since it belongs to the
  // parent layout rather than to this route.
  errorComponent: ({ reset }) => <RouteErrorState message="We couldn't load your trigger settings." reset={reset} />,
  pendingComponent: AnalysisTriggersPending,
  component: AnalysisTriggersPage,
});

function AnalysisTriggersPending() {
  return (
    <div>
      <AnalysisTriggersSkeleton />
    </div>
  );
}

/** The fixed `/start analysis` PR comment - the command is not configurable, only the label is. */
const START_ANALYSIS_COMMAND = "/start analysis";

function AnalysisTriggersPage() {
  return (
    <div>
      <Suspense fallback={<AnalysisTriggersSkeleton />}>
        <AnalysisTriggersContent />
      </Suspense>
    </div>
  );
}

function AnalysisTriggersContent() {
  const app = useCurrentApplication();
  const { data: config } = useTriggerConfig(app.id);
  const updateConfig = useUpdateTriggerConfig(app.id);

  const [autoRun, setAutoRun] = useState(config.autoRunOnReadyForReview);
  const [label, setLabel] = useState(config.analysisTriggerLabel);

  const labelResult = AnalysisTriggerLabelSchema.safeParse(label);
  const labelError = labelResult.success ? undefined : labelResult.error.issues[0]?.message;

  const isDirty = autoRun !== config.autoRunOnReadyForReview || label !== config.analysisTriggerLabel;
  const canSave = isDirty && labelResult.success && !updateConfig.isPending;

  function handleDiscard() {
    setAutoRun(config.autoRunOnReadyForReview);
    setLabel(config.analysisTriggerLabel);
  }

  function handleSave() {
    if (!labelResult.success) return;
    updateConfig.mutate(
      {
        applicationId: app.id,
        autoRunOnReadyForReview: autoRun,
        analysisTriggerLabel: labelResult.data,
      },
      {
        onSuccess: (saved) => {
          setAutoRun(saved.autoRunOnReadyForReview);
          setLabel(saved.analysisTriggerLabel);
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-2xl space-y-2">
          <h2 className="text-xl font-medium tracking-tight text-text-primary">When Autonoma runs</h2>
          <p className="text-sm text-text-secondary">
            By default, Autonoma doesn't run on its own. A run starts when someone asks for it - a PR comment, a label,
            your editor (via MCP), or from here. You can also turn on automatic runs when a PR is marked ready for
            review.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" onClick={handleDiscard} disabled={!isDirty || updateConfig.isPending}>
            Discard
          </Button>
          <Button variant="accent" onClick={handleSave} disabled={!canSave} aria-label="analysis-triggers-save">
            {updateConfig.isPending ? "Saving..." : "Save changes"}
          </Button>
        </div>
      </header>

      <section className="space-y-3">
        <SectionLabel
          label="Automatic run"
          meta="the only setting · off by default"
          repoFullName={config.repoFullName}
        />
        <Panel>
          <PanelBody className="space-y-3">
            <div className="flex items-start gap-3">
              <Switch
                checked={autoRun}
                onCheckedChange={setAutoRun}
                aria-label="analysis-triggers-auto-run"
                className="mt-0.5"
              />
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <GitPullRequestIcon size={16} className="text-text-secondary" />
                  <span className="text-sm font-medium text-text-primary">
                    Run automatically when a PR is marked ready for review
                  </span>
                  <Badge variant={autoRun ? "success" : "outline"} className="font-mono text-3xs uppercase">
                    {autoRun ? "On" : "Off"}
                  </Badge>
                </div>
                <p className="text-xs text-text-secondary">
                  Leaving draft is the closest thing GitHub has to "this is done" - the only event where a run without
                  an explicit request is usually welcome. Drafts and pushes never trigger anything.
                </p>
                <p className="text-xs text-text-secondary">
                  Nothing runs on its own. Every run starts because someone or something asked for it.
                </p>
              </div>
            </div>
          </PanelBody>
        </Panel>
      </section>

      <section className="space-y-3">
        <SectionLabel label="On request" meta="always available" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <OnRequestCard
            icon={ChatCircleIcon}
            title="Comment on the PR"
            source="GitHub"
            description="Any collaborator posts the command. Works every time, so a dev can re-run after pushing a fix."
          >
            <div className="flex items-center gap-2">
              <code className="rounded-md border border-primary/40 bg-primary/10 px-2 py-1 font-mono text-xs text-primary">
                {START_ANALYSIS_COMMAND}
              </code>
              <CopyButton value={START_ANALYSIS_COMMAND} label="Copy the start-analysis command" />
              <span className="font-mono text-2xs text-text-secondary">fixed command</span>
            </div>
          </OnRequestCard>

          <OnRequestCard
            icon={TagIcon}
            title="Add a label"
            source="GitHub · configurable"
            description="Adding the label starts a run. Which label is up to the team - pick one that fits your existing conventions."
          >
            <div className="space-y-1.5">
              <label
                htmlFor="analysis-trigger-label"
                className="block font-mono text-2xs uppercase tracking-widest text-text-secondary"
              >
                Which label
              </label>
              <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                <div className="flex items-center gap-1.5">
                  <Input
                    id="analysis-trigger-label"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    aria-label="analysis-triggers-label-input"
                    aria-invalid={labelError != null}
                    className="max-w-xs font-mono text-sm"
                  />
                  <CopyButton value={label} label="Copy the label" disabled={!labelResult.success} />
                </div>
                <span className="font-mono text-2xs text-text-secondary">created on the repo if missing</span>
              </div>
              {labelError != null && <p className="font-mono text-2xs text-status-critical">{labelError}</p>}
            </div>
          </OnRequestCard>

          <OnRequestCard
            icon={PlugsConnectedIcon}
            title="MCP client"
            source="Agent"
            description="Claude or Cursor calls the run tool for the current branch, without leaving the editor."
          />

          <OnRequestCard
            icon={CursorClickIcon}
            title="From Autonoma"
            source="Dashboard"
            description="Run tests from the app detail page or the run list, for any branch."
          />
        </div>
        <div className="flex items-start gap-2 pt-1">
          <InfoIcon size={14} className="mt-0.5 shrink-0 text-text-secondary" />
          <div className="space-y-1 text-xs text-text-secondary">
            <p>
              Each of these needs a human or an agent to act, so none of them can surprise a team with an unwanted run.
            </p>
            <p>New PRs get a comment showing your team how to start a run.</p>
          </div>
        </div>
      </section>
    </div>
  );
}

function SectionLabel({ label, meta, repoFullName }: { label: string; meta: string; repoFullName?: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-dim pb-2">
      <div className="flex items-center gap-2">
        <span className="size-1.5 rounded-xs bg-primary" />
        <span className="font-mono text-2xs uppercase tracking-widest text-text-primary">{label}</span>
        <span className="font-mono text-2xs uppercase tracking-widest text-text-secondary">{meta}</span>
      </div>
      {repoFullName != null && (
        <span className="font-mono text-2xs uppercase tracking-widest text-text-secondary">
          GitHub · {repoFullName}
        </span>
      )}
    </div>
  );
}

/** A subtle icon button that copies `value` to the clipboard and briefly confirms with a check. */
function CopyButton({ value, label, disabled }: { value: string; label: string; disabled?: boolean }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <Button variant="ghost" size="icon-xs" onClick={handleCopy} disabled={disabled} aria-label={label}>
      {copied ? <CheckIcon size={14} className="text-status-success" /> : <CopyIcon size={14} />}
    </Button>
  );
}

function OnRequestCard({
  icon: IconComponent,
  title,
  source,
  description,
  children,
}: {
  icon: Icon;
  title: string;
  source: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <Panel className="h-full">
      <PanelBody className="flex h-full flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <IconComponent size={16} className="text-primary" />
            <span className="text-sm font-medium text-text-primary">{title}</span>
          </div>
          <span className="font-mono text-2xs uppercase tracking-widest text-text-secondary">{source}</span>
        </div>
        <p className="text-xs text-text-secondary">{description}</p>
        {children != null && (
          <>
            <Separator className="my-1" />
            {children}
          </>
        )}
      </PanelBody>
    </Panel>
  );
}

export function AnalysisTriggersSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-6 w-72" />
          <Skeleton className="h-4 w-full max-w-xl" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-32" />
        </div>
      </div>
      <Skeleton className="h-32 w-full" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className={cn("w-full", i < 2 ? "h-40" : "h-28")} />
        ))}
      </div>
    </div>
  );
}
