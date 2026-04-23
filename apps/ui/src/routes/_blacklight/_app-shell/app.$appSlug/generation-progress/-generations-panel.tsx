import { Badge } from "@autonoma/blacklight";
import { GenerationCard } from "components/generation/generation-card";
import type { EnrichedGeneration } from "lib/query/snapshot-edit.queries";

export function GenerationsPanel({ generations }: { generations: EnrichedGeneration[] }) {
  return (
    <div className="flex flex-col overflow-hidden border border-border-mid bg-surface-raised">
      <div className="flex shrink-0 items-center gap-2 border-b border-border-dim px-4 py-3">
        <span className="text-sm font-medium text-text-primary">Generations</span>
        <Badge variant="secondary" className="px-1.5 py-0 text-3xs">
          {generations.length}
        </Badge>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {generations.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-2xs text-text-tertiary">No generations yet</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {generations.map((g) => (
              <GenerationCard
                key={g.generationId}
                generationId={g.generationId}
                testCaseName={g.testCaseName}
                status={g.status}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
