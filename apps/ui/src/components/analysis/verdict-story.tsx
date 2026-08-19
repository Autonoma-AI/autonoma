import { cn } from "@autonoma/blacklight";
import type { InvestigationEvidence } from "@autonoma/types";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { FileCodeIcon } from "@phosphor-icons/react/FileCode";
import { GitDiffIcon } from "@phosphor-icons/react/GitDiff";
import { ImageIcon } from "@phosphor-icons/react/Image";
import { InfoIcon } from "@phosphor-icons/react/Info";
import { TerminalWindowIcon } from "@phosphor-icons/react/TerminalWindow";
import { VideoCameraIcon } from "@phosphor-icons/react/VideoCamera";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
import { CodeBlock, evidencePermalink } from "components/investigation/code-block";
import { type ComponentType, type ReactNode, useState } from "react";

/** The section-title icon size, so every verdict-story heading marks its section at the same scale. */
const SECTION_ICON_SIZE = 13;

/**
 * The presentational primitives of a finding's verdict story - the prose sections, the expected/actual claims,
 * the observed-app-issues note, the classification-error block, and the code-evidence list. Shared by the
 * full-screen finding page ({@link import("components/investigation/finding-detail").FindingDetail}) and the
 * checkpoint drawer's summary tab so the two render the same verdict in one voice instead of two drifting copies.
 * Each surface still owns its own section order and media panel; only the atoms live here.
 *
 * `level` is the heading level the surface nests these under: the full page (h1 headline) passes `2`, the drawer
 * (h2 headline) leaves the default `3`, so the document outline stays correct in both.
 */
type HeadingLevel = 2 | 3;

/** The two app-behavior claims, tinted to their plane so the expected/actual contrast reads at a glance. */
const BEHAVIOR_TONES = {
  expected: "border-l-status-pending/60 bg-status-pending/5",
  actual: "border-l-status-critical/60 bg-status-critical/5",
} as const;

/** Each evidence source gets an icon and an accent so a reviewer skims the list by kind instead of reading tags. */
interface EvidenceSourceStyle {
  Icon: ComponentType<{ size?: number; className?: string }>;
  accent: string;
  border: string;
}

const EVIDENCE_SOURCE_STYLES: Record<string, EvidenceSourceStyle> = {
  run: { Icon: TerminalWindowIcon, accent: "text-status-pending", border: "border-l-status-pending/60" },
  screenshot: { Icon: ImageIcon, accent: "text-status-pending", border: "border-l-status-pending/60" },
  video: { Icon: VideoCameraIcon, accent: "text-status-pending", border: "border-l-status-pending/60" },
  code: { Icon: FileCodeIcon, accent: "text-violet-accent", border: "border-l-violet-accent/60" },
  diff: { Icon: GitDiffIcon, accent: "text-status-high", border: "border-l-status-high/60" },
};

const FALLBACK_EVIDENCE_STYLE: EvidenceSourceStyle = {
  Icon: InfoIcon,
  accent: "text-text-secondary",
  border: "border-l-border-mid",
};

function evidenceSourceStyle(source: string): EvidenceSourceStyle {
  return EVIDENCE_SOURCE_STYLES[source.toLowerCase().trim()] ?? FALLBACK_EVIDENCE_STYLE;
}

function isBlank(children: ReactNode): boolean {
  return children == null || (typeof children === "string" && children.trim() === "");
}

export function VerdictSectionTitle({
  level = 3,
  icon,
  children,
}: {
  level?: HeadingLevel;
  /** An optional marker rendered before the label; the drawer sets one per section, the full page leaves it off. */
  icon?: ReactNode;
  children: ReactNode;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  // Compact surfaces (the drawer, level 3) render section titles semibold; the full page (level 2) uses the
  // lighter weight its other headings share.
  return (
    <Heading
      className={cn(
        "flex items-center gap-1.5 font-mono text-2xs uppercase tracking-widest text-text-secondary",
        level === 3 && "font-semibold",
      )}
    >
      {icon}
      {children}
    </Heading>
  );
}

/** A titled prose paragraph that renders nothing when its content is absent or blank. */
export function ProseSection({
  title,
  level = 3,
  tone = "primary",
  icon,
  children,
}: {
  title: string;
  level?: HeadingLevel;
  tone?: "primary" | "secondary";
  icon?: ReactNode;
  children: ReactNode;
}) {
  if (isBlank(children)) return null;
  return (
    <section className="flex flex-col gap-2">
      <VerdictSectionTitle level={level} icon={icon}>
        {title}
      </VerdictSectionTitle>
      <p className={cn("text-sm leading-relaxed", tone === "secondary" ? "text-text-secondary" : "text-text-primary")}>
        {children}
      </p>
    </section>
  );
}

/** The expected app behavior of an app-health verdict, tinted info-blue. Renders nothing when the field is absent. */
export function ExpectedSection({
  level = 3,
  icon,
  children,
}: {
  level?: HeadingLevel;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <BehaviorClaim title="Expected" tone="expected" level={level} icon={icon}>
      {children}
    </BehaviorClaim>
  );
}

/** The actual app behavior of an app-health verdict, tinted danger-red. Renders nothing when the field is absent. */
export function ActualSection({
  level = 3,
  icon,
  children,
}: {
  level?: HeadingLevel;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <BehaviorClaim title="Actual" tone="actual" level={level} icon={icon}>
      {children}
    </BehaviorClaim>
  );
}

/**
 * The expected/actual pair laid side-by-side so the contrast reads across, not down - the shape an app-health
 * verdict is judged on. Renders nothing when neither is present (a coverage verdict), and falls back to a single
 * full-width claim when only one side exists rather than leave a lopsided empty column.
 */
export function ExpectedActualSections({
  expected,
  actual,
  level = 3,
}: {
  expected: ReactNode;
  actual: ReactNode;
  level?: HeadingLevel;
}) {
  const hasExpected = !isBlank(expected);
  const hasActual = !isBlank(actual);
  if (!hasExpected && !hasActual) return null;
  const expectedIcon = <CheckCircleIcon size={SECTION_ICON_SIZE} className="text-status-pending" />;
  const actualIcon = <XCircleIcon size={SECTION_ICON_SIZE} className="text-status-critical" />;
  if (!hasExpected || !hasActual) {
    return (
      <>
        <ExpectedSection level={level} icon={expectedIcon}>
          {expected}
        </ExpectedSection>
        <ActualSection level={level} icon={actualIcon}>
          {actual}
        </ActualSection>
      </>
    );
  }
  return (
    <div className="grid grid-cols-2 items-stretch gap-3">
      <ExpectedSection level={level} icon={expectedIcon}>
        {expected}
      </ExpectedSection>
      <ActualSection level={level} icon={actualIcon}>
        {actual}
      </ActualSection>
    </div>
  );
}

function BehaviorClaim({
  title,
  tone,
  level,
  icon,
  children,
}: {
  title: string;
  tone: keyof typeof BEHAVIOR_TONES;
  level: HeadingLevel;
  icon?: ReactNode;
  children: ReactNode;
}) {
  if (isBlank(children)) return null;
  return (
    <section className={cn("flex flex-col gap-2 rounded-lg border-l-2 px-4 py-3", BEHAVIOR_TONES[tone])}>
      <VerdictSectionTitle level={level} icon={icon}>
        {title}
      </VerdictSectionTitle>
      <p className="text-sm leading-relaxed text-text-primary">{children}</p>
    </section>
  );
}

/**
 * The neutral callout for app problems the run saw independent of this test's pass/fail. Deliberately quiet (a
 * grey box, not a status tone): these are context on the app, not this verdict's headline, so they must not
 * out-shout the expected/actual claims above them.
 */
export function ObservedAppIssuesNote({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  if (isBlank(children)) return null;
  return (
    <div className="rounded-lg border border-border-dim bg-surface-raised px-4 py-3 text-sm leading-relaxed text-text-secondary">
      {icon != null && <span className="mr-1.5 inline-flex translate-y-0.5 text-text-secondary">{icon}</span>}
      <span className="font-medium text-text-primary">App issues observed: </span>
      {children}
    </div>
  );
}

/** The verbatim classifier error, shown in place of the verdict fields when the model failed to classify. */
export function ClassificationErrorBlock({
  level = 3,
  icon,
  error,
}: {
  level?: HeadingLevel;
  icon?: ReactNode;
  error: string;
}) {
  return (
    <section className="flex flex-col gap-2">
      <VerdictSectionTitle level={level} icon={icon}>
        Classification error
      </VerdictSectionTitle>
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-surface-void p-4 font-mono text-2xs text-text-secondary">
        {error}
      </pre>
    </section>
  );
}

/**
 * The finding's code evidence, as a colored card per item keyed by its source. `collapsible` folds the whole list
 * behind its title (the drawer, whose narrow panel would otherwise be a wall of snippets); the full page leaves it
 * expanded. `repoFullName` / `commitSha` are optional - without them the permalinks simply do not render.
 */
export function VerdictEvidence({
  evidence,
  level = 3,
  collapsible = false,
  icon,
  repoFullName,
  commitSha,
}: {
  evidence: InvestigationEvidence[];
  level?: HeadingLevel;
  collapsible?: boolean;
  icon?: ReactNode;
  repoFullName?: string;
  commitSha?: string;
}) {
  const [open, setOpen] = useState(!collapsible);
  if (evidence.length === 0) return null;

  const items = (
    <div className="flex flex-col gap-2">
      {evidence.map((item, i) => (
        <EvidenceItem key={i} item={item} repoFullName={repoFullName} commitSha={commitSha} />
      ))}
    </div>
  );

  if (!collapsible) {
    return (
      <section className="flex flex-col gap-2">
        <VerdictSectionTitle level={level} icon={icon}>
          Evidence
        </VerdictSectionTitle>
        {items}
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex items-center gap-2 text-left"
      >
        <VerdictSectionTitle level={level} icon={icon}>
          Evidence
        </VerdictSectionTitle>
        <span className="font-mono text-3xs text-text-secondary">{evidence.length}</span>
        <CaretDownIcon size={12} className={cn("text-text-secondary transition-transform", open && "rotate-180")} />
      </button>
      {open && items}
    </section>
  );
}

function EvidenceItem({
  item,
  repoFullName,
  commitSha,
}: {
  item: InvestigationEvidence;
  repoFullName?: string;
  commitSha?: string;
}) {
  const { Icon, accent, border } = evidenceSourceStyle(item.source);
  const permalink = evidencePermalink(item, repoFullName, commitSha);
  const snippet = item.snippet;
  const hasSnippet = snippet != null && snippet !== "";
  const fileLabel =
    item.file != null
      ? `${item.repo != null ? `${item.repo} › ` : ""}${item.file}${item.lines != null ? `:${item.lines}` : ""}`
      : undefined;
  return (
    <div className={cn("overflow-hidden rounded-md border border-l-2 border-border-dim bg-surface-void", border)}>
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon size={13} className={cn("shrink-0", accent)} />
        <span className={cn("font-mono text-3xs uppercase tracking-wider", accent)}>{item.source}</span>
        {/* Snippet-bearing items show their file in the code block's own header, so only the snippet-less ones
            surface the file here - otherwise the path would appear twice. */}
        {!hasSnippet &&
          fileLabel != null &&
          (permalink != null ? (
            <a
              href={permalink}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate font-mono text-3xs text-text-secondary hover:text-text-primary hover:underline"
            >
              {fileLabel}
            </a>
          ) : (
            <span className="truncate font-mono text-3xs text-text-secondary">{fileLabel}</span>
          ))}
      </div>
      {item.detail !== "" && <p className="px-3 pb-2 text-sm leading-relaxed text-text-secondary">{item.detail}</p>}
      {hasSnippet && (
        <div className="px-3 pb-3">
          <CodeBlock code={snippet} file={item.file} lines={item.lines} permalink={permalink} />
        </div>
      )}
    </div>
  );
}
