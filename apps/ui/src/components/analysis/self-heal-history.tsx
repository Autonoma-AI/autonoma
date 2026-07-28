import { Badge } from "@autonoma/blacklight";
import type { AnalysisClassificationSummary } from "@autonoma/types";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { analysisVerdictMeta } from "components/analysis/verdict-meta";
import { useAuth } from "lib/auth";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

/**
 * The finding's self-heal history: every time the Investigator classified this test in this run, oldest first.
 * More than one entry means it rewrote the plan and re-ran, and the entry BEFORE each rewrite is the verdict that
 * authored it - so a self-heal that turned out wrong can be read back to the reasoning that produced it.
 *
 * Admin-only and hidden for a single-classification finding: this is a debugging trail, not part of the report.
 * Each entry links to its own classifier conversation and to the run it judged (which renders that run's video and
 * trace), so nothing here duplicates the finding page above it.
 */
export function SelfHealHistory({ classifications }: { classifications: AnalysisClassificationSummary[] }) {
  const { isAdmin } = useAuth();
  if (!isAdmin || classifications.length < 2) return null;

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-dashed border-border-dim px-4 py-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-mono text-2xs uppercase tracking-widest text-text-secondary">Self-heal history</h2>
        <p className="text-2xs text-text-secondary">
          The plan was rewritten and re-run. Each pass below is the verdict that motivated the rewrite after it.
        </p>
      </div>
      <ol className="flex flex-col gap-2">
        {classifications.map((classification, index) => (
          <HistoryRow
            key={classification.id}
            classification={classification}
            isCurrent={index === classifications.length - 1}
          />
        ))}
      </ol>
    </section>
  );
}

function HistoryRow({
  classification,
  isCurrent,
}: {
  classification: AnalysisClassificationSummary;
  isCurrent: boolean;
}) {
  const meta = analysisVerdictMeta(classification.category);
  return (
    <li className="flex flex-col gap-1 border-l border-border-dim pl-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-2xs text-text-secondary">#{classification.number}</span>
        <Badge variant={meta.variant} className="uppercase">
          {meta.label}
        </Badge>
        {isCurrent && <span className="font-mono text-2xs uppercase tracking-widest text-text-secondary">current</span>}
      </div>
      <p className="text-sm leading-relaxed text-text-primary">{classification.headline}</p>
      <div className="flex flex-wrap items-center gap-3 font-mono text-2xs uppercase tracking-widest">
        {classification.conversationUrl != null && (
          <a
            href={classification.conversationUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary-ink hover:underline"
          >
            <ArrowSquareOutIcon size={11} />
            Classifier reasoning
          </a>
        )}
        <AppLink
          to="/app/$appSlug/generations/$generationId"
          params={{ generationId: classification.generationId }}
          className="inline-flex items-center gap-1 text-text-secondary hover:text-text-primary hover:underline"
        >
          <ArrowSquareOutIcon size={11} />
          Run
        </AppLink>
      </div>
    </li>
  );
}
