import { Badge, Button, Card, CardContent } from "@autonoma/blacklight";
import { LightningIcon } from "@phosphor-icons/react/Lightning";
import { XIcon } from "@phosphor-icons/react/X";
import type { EnrichedGeneration } from "lib/query/snapshot-edit.queries";
import { useDiscardGeneration, useEditSession, useQueueGenerations } from "lib/query/snapshot-edit.queries";
import { AppLink } from "../../../-app-link";

const STATUS_BADGE_VARIANT = {
  pending: "status-pending",
  queued: "status-pending",
  running: "status-running",
  success: "status-passed",
  failed: "status-failed",
} as const;

export function GenerationsTab({ snapshotId }: { snapshotId: string }) {
  const { data: session } = useEditSession(snapshotId);
  const queueGenerations = useQueueGenerations();

  return (
    <div className="grid h-[calc(100dvh-340px)] grid-cols-3 gap-4">
      <GenerationColumn
        title="Pending"
        generations={session.pendingGenerations}
        renderCard={(g) => <PendingGenerationCard key={g.generationId} snapshotId={snapshotId} generation={g} />}
        action={
          session.pendingGenerations.length > 0 ? (
            <Button
              size="xs"
              onClick={() => queueGenerations.mutate({ snapshotId })}
              disabled={queueGenerations.isPending}
            >
              <LightningIcon size={12} />
              {queueGenerations.isPending ? "Queuing..." : "Generate all"}
            </Button>
          ) : undefined
        }
        emptyMessage="No pending generations"
      />
      <GenerationColumn
        title="In Progress"
        generations={session.activeGenerations}
        emptyMessage="No active generations"
      />
      <GenerationColumn
        title="Completed"
        generations={session.completedGenerations}
        emptyMessage="No completed generations"
      />
    </div>
  );
}

// ─── Column ─────────────────────────────────────────────────────────────────

interface GenerationColumnProps {
  title: string;
  generations: EnrichedGeneration[];
  renderCard?: (generation: EnrichedGeneration) => React.ReactNode;
  action?: React.ReactNode;
  emptyMessage: string;
}

function GenerationColumn({ title, generations, renderCard, action, emptyMessage }: GenerationColumnProps) {
  return (
    <div className="flex flex-col overflow-hidden border border-border-mid bg-surface-raised">
      <div className="flex shrink-0 items-center justify-between border-b border-border-dim px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-primary">{title}</span>
          <Badge variant="secondary" className="px-1.5 py-0 text-3xs">
            {generations.length}
          </Badge>
        </div>
        {action}
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {generations.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-2xs text-text-tertiary">{emptyMessage}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {generations.map((g) =>
              renderCard != null ? renderCard(g) : <GenerationCard key={g.generationId} generation={g} />,
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Card ───────────────────────────────────────────────────────────────────

function PendingGenerationCard({ snapshotId, generation }: { snapshotId: string; generation: EnrichedGeneration }) {
  const discardGeneration = useDiscardGeneration();

  return (
    <Card variant="raised" size="default">
      <CardContent className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-sm text-text-primary">{generation.testCaseName}</span>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={STATUS_BADGE_VARIANT[generation.status]}>{generation.status}</Badge>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-text-tertiary hover:text-status-critical"
            onClick={() => discardGeneration.mutate({ snapshotId, generationId: generation.generationId })}
            disabled={discardGeneration.isPending}
          >
            <XIcon size={12} />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function GenerationCard({ generation }: { generation: EnrichedGeneration }) {
  return (
    <AppLink to="/app/$appSlug/generations/$generationId" params={{ generationId: generation.generationId }}>
      <Card variant="raised" size="default" className="transition-colors hover:bg-surface-base">
        <CardContent className="flex items-center justify-between gap-2">
          <span className="truncate font-mono text-sm text-text-primary">{generation.testCaseName}</span>
          <Badge variant={STATUS_BADGE_VARIANT[generation.status]} className="shrink-0">
            {generation.status}
          </Badge>
        </CardContent>
      </Card>
    </AppLink>
  );
}
