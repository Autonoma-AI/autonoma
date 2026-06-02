import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import type * as React from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import { HealthStat, PrHealthPill, type SnapshotHealth, type SnapshotHealthCounts } from "./health-summary";
import { MetricCard, MetricLabel } from "./metric-card";

export interface VerdictHeroCta {
  label: string;
  href: string;
  external?: boolean;
  icon?: React.ReactNode;
  variant?: "primary" | "secondary";
}

export interface VerdictHeroProps {
  health: SnapshotHealth;
  summary: string;
  counts: SnapshotHealthCounts;
  bugs: number;
  ctas: VerdictHeroCta[];
  className?: string;
}

export function VerdictHero({ health, summary, counts, bugs, ctas, className }: VerdictHeroProps) {
  return (
    <section
      className={cn(
        "border border-border-mid bg-surface-raised px-5 py-5 shadow-[0_1px_0_rgba(255,255,255,0.04)]",
        className,
      )}
    >
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-col gap-3">
          <PrHealthPill health={health} className="w-fit" />
          <div className="min-w-0">
            <p className="text-lg font-medium text-text-primary">{summary}</p>
            <p className="mt-1 text-sm text-text-secondary">
              {counts.passing}/{counts.totalTests} passing · {bugs} {bugs === 1 ? "bug" : "bugs"} · {counts.quarantined}{" "}
              quarantined
            </p>
          </div>
          {ctas.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {ctas.map((cta) => (
                <a
                  key={cta.label}
                  href={cta.href}
                  target={cta.external ? "_blank" : undefined}
                  rel={cta.external ? "noopener noreferrer" : undefined}
                >
                  <Button variant={cta.variant === "secondary" ? "outline" : "default"} size="sm">
                    {cta.icon}
                    {cta.label}
                    {cta.external && <ArrowSquareOutIcon size={12} />}
                  </Button>
                </a>
              ))}
            </div>
          )}
        </div>

        <div className="grid min-w-0 grid-cols-3 gap-4 border-t border-border-dim pt-4 lg:min-w-80 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-5">
          <MetricCard>
            <MetricLabel>Passing</MetricLabel>
            <HealthStat value={counts.passing} label="tests" />
          </MetricCard>
          <MetricCard>
            <MetricLabel>Bugs</MetricLabel>
            <HealthStat value={bugs} label="open" tone={bugs > 0 ? "critical" : "neutral"} />
          </MetricCard>
          <MetricCard>
            <MetricLabel>Quarantined</MetricLabel>
            <HealthStat
              value={counts.quarantined}
              label="quarantined"
              tone={counts.quarantined > 0 ? "critical" : "neutral"}
            />
          </MetricCard>
        </div>
      </div>
    </section>
  );
}
