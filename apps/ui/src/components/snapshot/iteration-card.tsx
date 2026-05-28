import { Badge } from "@autonoma/blacklight";
import { SentryLogsLink } from "components/observability-links";
import { useAuth } from "lib/auth";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { ReasoningBlock } from "./reasoning-block";
import { RefinementActionRow } from "./refinement-action-row";
import type {
  IterationFailedAtGeneration,
  IterationFailedAtReplay,
  IterationValidated,
  RefinementIteration,
} from "./refinement-types";
import { StageEmpty } from "./stage-empty";

interface IterationCardProps {
  iteration: RefinementIteration;
}

export function IterationCard({ iteration }: IterationCardProps) {
  const { isAdmin } = useAuth();
  const { inputs, outcomes, actions } = iteration;

  const duration = formatDuration(iteration.startedAt, iteration.finishedAt);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 text-2xs text-text-tertiary">
        <span>
          {inputs.length} plan{inputs.length === 1 ? "" : "s"} in scope
        </span>
        {duration != null && <span>· {duration}</span>}
        {isAdmin && (
          <span className="ml-auto">
            <SentryLogsLink filterField="iterationId" filterValue={iteration.id} />
          </span>
        )}
      </div>

      <InputsSection inputs={inputs} />
      <OutcomesSection outcomes={outcomes} />
      <ActionsSection actions={actions} />
    </div>
  );
}

function InputsSection({ inputs }: { inputs: RefinementIteration["inputs"] }) {
  if (inputs.length === 0) {
    return (
      <Section title="Inputs" count={0}>
        <StageEmpty message="No plans tracked for this iteration" />
      </Section>
    );
  }

  return (
    <Section title="Inputs" count={inputs.length}>
      <div className="flex flex-col gap-1.5">
        {inputs.map((input) => (
          <PlanInputRow key={input.planId} testCase={input.testCase} />
        ))}
      </div>
    </Section>
  );
}

function OutcomesSection({ outcomes }: { outcomes: RefinementIteration["outcomes"] }) {
  const total =
    outcomes.validated.length +
    outcomes.failedAtGeneration.length +
    outcomes.failedAtReplay.length +
    outcomes.awaiting.length;

  if (total === 0) {
    return (
      <Section title="Outcomes" count={0}>
        <StageEmpty message="Awaiting outcomes" />
      </Section>
    );
  }

  return (
    <Section title="Outcomes" count={total}>
      <div className="flex flex-col gap-3">
        {outcomes.validated.length > 0 && (
          <Bucket label="Validated" count={outcomes.validated.length} variant="success">
            {outcomes.validated.map((row) => (
              <ValidatedRow key={row.planId} row={row} />
            ))}
          </Bucket>
        )}
        {outcomes.failedAtGeneration.length > 0 && (
          <Bucket label="Failed at generation" count={outcomes.failedAtGeneration.length} variant="critical">
            {outcomes.failedAtGeneration.map((row) => (
              <FailedGenRow key={row.planId} row={row} />
            ))}
          </Bucket>
        )}
        {outcomes.failedAtReplay.length > 0 && (
          <Bucket label="Failed at replay" count={outcomes.failedAtReplay.length} variant="critical">
            {outcomes.failedAtReplay.map((row) => (
              <FailedReplayRow key={row.planId} row={row} />
            ))}
          </Bucket>
        )}
        {outcomes.awaiting.length > 0 && (
          <Bucket label="Awaiting" count={outcomes.awaiting.length} variant="outline">
            {outcomes.awaiting.map((row) => (
              <PlanInputRow key={row.planId} testCase={row.testCase} />
            ))}
          </Bucket>
        )}
      </div>
    </Section>
  );
}

function ActionsSection({ actions }: { actions: RefinementIteration["actions"] }) {
  return (
    <Section title="Healing actions" count={actions.length}>
      {actions.length === 0 ? (
        <StageEmpty message="No healing actions" />
      ) : (
        <div className="flex flex-col gap-1.5">
          {actions.map((action) => (
            <RefinementActionRow key={action.id} action={action} />
          ))}
        </div>
      )}
    </Section>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">{title}</span>
        <span className="font-mono text-2xs text-text-tertiary">({count})</span>
      </div>
      {children}
    </div>
  );
}

function Bucket({
  label,
  count,
  variant,
  children,
}: {
  label: string;
  count: number;
  variant: "success" | "critical" | "outline";
  children: React.ReactNode;
}) {
  const badgeVariant: "status-passed" | "status-failed" | "outline" =
    variant === "success" ? "status-passed" : variant === "critical" ? "status-failed" : "outline";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Badge variant={badgeVariant} className="px-1.5 py-0 text-3xs">
          {label} ({count})
        </Badge>
      </div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

function PlanInputRow({ testCase }: { testCase: { id: string; name: string; slug: string } }) {
  return (
    <div className="flex items-center gap-3 border border-border-dim bg-surface-raised px-4 py-2">
      <AppLink
        to="/app/$appSlug/tests/$testSlug"
        params={{ testSlug: testCase.slug }}
        className="min-w-0 flex-1 truncate font-mono text-sm text-text-primary hover:underline"
      >
        {testCase.name}
      </AppLink>
    </div>
  );
}

function ValidatedRow({ row }: { row: IterationValidated }) {
  return (
    <div className="flex items-center gap-3 border border-border-dim bg-surface-raised px-4 py-2">
      <AppLink
        to="/app/$appSlug/runs/$runId"
        params={{ runId: row.runId }}
        className="min-w-0 flex-1 truncate font-mono text-sm text-text-primary hover:underline"
      >
        {row.testCase.name}
      </AppLink>
    </div>
  );
}

function FailedGenRow({ row }: { row: IterationFailedAtGeneration }) {
  return (
    <FailedRow
      testCaseName={row.testCase.name}
      link={{ kind: "generation", id: row.generationId }}
      verdictLabel={row.verdictKind ?? row.generationStatus}
      reasoning={row.reviewReasoning}
    />
  );
}

function FailedReplayRow({ row }: { row: IterationFailedAtReplay }) {
  return (
    <FailedRow
      testCaseName={row.testCase.name}
      link={{ kind: "run", id: row.runId }}
      verdictLabel={row.verdictKind ?? row.runStatus}
      reasoning={row.reviewReasoning}
    />
  );
}

function FailedRow({
  testCaseName,
  link,
  verdictLabel,
  reasoning,
}: {
  testCaseName: string;
  link: { kind: "generation" | "run"; id: string };
  verdictLabel: string;
  reasoning?: string;
}) {
  const nameClassName = "min-w-0 flex-1 truncate font-mono text-sm text-text-primary hover:underline";
  const nameNode =
    link.kind === "generation" ? (
      <AppLink
        to="/app/$appSlug/generations/$generationId"
        params={{ generationId: link.id }}
        className={nameClassName}
      >
        {testCaseName}
      </AppLink>
    ) : (
      <AppLink to="/app/$appSlug/runs/$runId" params={{ runId: link.id }} className={nameClassName}>
        {testCaseName}
      </AppLink>
    );

  return (
    <div className="border border-border-dim bg-surface-raised">
      <div className="flex flex-wrap items-center gap-3 px-4 py-2">
        <Badge variant="status-failed" className="shrink-0 px-1.5 py-0 text-3xs">
          {verdictLabel}
        </Badge>
        {nameNode}
      </div>
      {reasoning != null && reasoning.trim().length > 0 && (
        <div className="border-t border-border-dim bg-surface-base px-4 py-2">
          <ReasoningBlock label="Review reasoning" content={reasoning} />
        </div>
      )}
    </div>
  );
}

function formatDuration(start: Date | string, end: Date | string | undefined): string | undefined {
  const startMs = new Date(start).getTime();
  const endMs = end != null ? new Date(end).getTime() : Date.now();
  const ms = endMs - startMs;
  if (ms < 0) return undefined;

  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}h ${remMin}m`;
}
