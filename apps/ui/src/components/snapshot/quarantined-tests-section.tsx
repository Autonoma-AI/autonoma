import { Badge } from "@autonoma/blacklight";
import { ShieldWarningIcon } from "@phosphor-icons/react/ShieldWarning";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import type { QuarantinedTest } from "./diffs-timeline-types";

const REASON_BADGE: Record<QuarantinedTest["reason"], { label: string; variant: "critical" | "high" }> = {
  application_bug: { label: "application bug", variant: "critical" },
  engine_limitation: { label: "engine limitation", variant: "high" },
};

interface QuarantinedTestsSectionProps {
  quarantinedTests: QuarantinedTest[];
}

export function QuarantinedTestsSection({ quarantinedTests }: QuarantinedTestsSectionProps) {
  if (quarantinedTests.length === 0) return null;

  return (
    <section className="flex flex-col gap-3 border border-status-high/40 bg-status-high/5 px-4 py-3">
      <header className="flex items-center gap-2">
        <ShieldWarningIcon size={14} className="shrink-0 text-status-high" />
        <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-status-high">
          Quarantined tests ({quarantinedTests.length})
        </span>
      </header>
      <p className="text-2xs text-text-secondary">
        These tests are suppressed in this snapshot. They will not be regenerated or run until the underlying bug or
        engine limitation is resolved.
      </p>
      <ul className="flex flex-col gap-2">
        {quarantinedTests.map((t) => (
          <QuarantinedTestRow key={t.testCase.id} test={t} />
        ))}
      </ul>
    </section>
  );
}

function QuarantinedTestRow({ test }: { test: QuarantinedTest }) {
  const reasonBadge = REASON_BADGE[test.reason];

  return (
    <li className="flex items-center gap-3 border border-border-dim bg-surface-raised px-4 py-2">
      <Badge variant={reasonBadge.variant} className="shrink-0">
        {reasonBadge.label}
      </Badge>
      <AppLink
        to="/app/$appSlug/tests/$testSlug"
        params={{ testSlug: test.testCase.slug }}
        className="min-w-0 flex-1 truncate font-mono text-sm text-text-primary hover:underline"
      >
        {test.testCase.name}
      </AppLink>
      {test.bugId != null ? (
        <AppLink
          to="/app/$appSlug/bugs/$bugId"
          params={{ bugId: test.bugId }}
          className="shrink-0 font-mono text-2xs uppercase tracking-widest text-text-tertiary hover:text-text-primary hover:underline"
        >
          Bug
        </AppLink>
      ) : (
        <AppLink
          to="/app/$appSlug/issues/$issueId"
          params={{ issueId: test.issueId }}
          className="shrink-0 font-mono text-2xs uppercase tracking-widest text-text-tertiary hover:text-text-primary hover:underline"
        >
          Issue
        </AppLink>
      )}
    </li>
  );
}
