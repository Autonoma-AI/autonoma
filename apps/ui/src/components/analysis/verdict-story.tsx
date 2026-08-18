import { Badge, cn } from "@autonoma/blacklight";
import type { InvestigationEvidence } from "@autonoma/types";
import { CodeBlock, evidencePermalink } from "components/investigation/code-block";
import type { ReactNode } from "react";

/**
 * The presentational primitives of a finding's verdict story - the prose sections, the observed-app-issues note,
 * the classification-error block, and the code-evidence list. Shared by the full-screen finding page
 * ({@link import("components/investigation/finding-detail").FindingDetail}) and the checkpoint drawer's summary
 * tab so the two render the same verdict in one voice instead of two drifting copies. Each surface still owns its
 * own section order and media panel; only the atoms live here.
 *
 * `level` is the heading level the surface nests these under: the full page (h1 headline) passes `2`, the drawer
 * (h2 headline) leaves the default `3`, so the document outline stays correct in both.
 */
type HeadingLevel = 2 | 3;

function isBlank(children: ReactNode): boolean {
  return children == null || (typeof children === "string" && children.trim() === "");
}

export function VerdictSectionTitle({ level = 3, children }: { level?: HeadingLevel; children: ReactNode }) {
  const Heading = level === 2 ? "h2" : "h3";
  // Compact surfaces (the drawer, level 3) render section titles semibold; the full page (level 2) uses the
  // lighter weight its other headings share.
  return (
    <Heading
      className={cn("font-mono text-2xs uppercase tracking-widest text-text-secondary", level === 3 && "font-semibold")}
    >
      {children}
    </Heading>
  );
}

/** A titled prose paragraph that renders nothing when its content is absent or blank. */
export function ProseSection({
  title,
  level = 3,
  tone = "primary",
  children,
}: {
  title: string;
  level?: HeadingLevel;
  tone?: "primary" | "secondary";
  children: ReactNode;
}) {
  if (isBlank(children)) return null;
  return (
    <section className="flex flex-col gap-2">
      <VerdictSectionTitle level={level}>{title}</VerdictSectionTitle>
      <p className={cn("text-sm leading-relaxed", tone === "secondary" ? "text-text-secondary" : "text-text-primary")}>
        {children}
      </p>
    </section>
  );
}

/** The warn-toned callout for app problems the run saw independent of this test's pass/fail. */
export function ObservedAppIssuesNote({ children }: { children: ReactNode }) {
  if (isBlank(children)) return null;
  return (
    <div className="rounded-lg border border-status-warn/30 bg-status-warn/5 px-4 py-3 text-sm leading-relaxed text-text-primary">
      <span className="font-medium">App issues observed: </span>
      {children}
    </div>
  );
}

/** The verbatim classifier error, shown in place of the verdict fields when the model failed to classify. */
export function ClassificationErrorBlock({ level = 3, error }: { level?: HeadingLevel; error: string }) {
  return (
    <section className="flex flex-col gap-2">
      <VerdictSectionTitle level={level}>Classification error</VerdictSectionTitle>
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-surface-void p-4 font-mono text-2xs text-text-secondary">
        {error}
      </pre>
    </section>
  );
}

/**
 * The finding's code evidence: a snippet renders as a permalinked code block, a snippet-less item as its cited
 * file (linked when a repo/commit resolve a permalink) or a plain detail line. `repoFullName` / `commitSha` are
 * optional - without them the permalinks simply do not render.
 */
export function VerdictEvidence({
  evidence,
  level = 3,
  repoFullName,
  commitSha,
}: {
  evidence: InvestigationEvidence[];
  level?: HeadingLevel;
  repoFullName?: string;
  commitSha?: string;
}) {
  if (evidence.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <VerdictSectionTitle level={level}>Evidence</VerdictSectionTitle>
      <div className="flex flex-col gap-3">
        {evidence.map((item, i) => (
          <EvidenceItem key={i} item={item} repoFullName={repoFullName} commitSha={commitSha} />
        ))}
      </div>
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
  const permalink = evidencePermalink(item, repoFullName, commitSha);
  const snippet = item.snippet;
  const fileLabel =
    item.file != null
      ? `${item.repo != null ? `${item.repo} › ` : ""}${item.file}${item.lines != null ? `:${item.lines}` : ""}`
      : undefined;
  return (
    <div className="flex flex-col gap-2">
      {item.detail !== "" && (
        <p className="text-sm leading-relaxed text-text-secondary">
          <span className="mr-2 font-mono text-3xs uppercase text-text-secondary">[{item.source}]</span>
          {item.detail}
        </p>
      )}
      {snippet != null && snippet !== "" ? (
        <CodeBlock code={snippet} file={item.file} lines={item.lines} sourceLabel={item.source} permalink={permalink} />
      ) : (
        fileLabel != null && (
          <div className="flex items-center gap-2 rounded-md border border-border-dim bg-surface-raised px-3 py-2 font-mono text-3xs">
            <Badge variant="outline" className="uppercase">
              {item.source}
            </Badge>
            {permalink != null ? (
              <a href={permalink} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                {fileLabel}
              </a>
            ) : (
              <span className="text-text-primary">{fileLabel}</span>
            )}
          </div>
        )
      )}
    </div>
  );
}
