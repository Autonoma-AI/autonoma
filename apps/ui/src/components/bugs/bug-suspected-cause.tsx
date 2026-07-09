import { CheckIcon } from "@phosphor-icons/react/Check";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import type { RouterOutputs } from "lib/trpc";
import { useState } from "react";

type BugReport = RouterOutputs["bugs"]["detail"]["report"];
type SuspectedCause = NonNullable<BugReport>["suspectedCause"];
type CodeReference = NonNullable<SuspectedCause>["codeReferences"][number];

const COPIED_RESET_MS = 1200;

// Hedged "Suspected cause" - the healing agent's code-level guess at why the bug
// happens. Deliberately subordinate to and below the proven "why this is a bug"
// case: dashed, muted, never labelled "Root cause", so a wrong guess can never sit
// above or contaminate the evidence. Renders nothing until a cause was grounded.
export function BugSuspectedCause({ report }: { report: BugReport }) {
  const cause = report?.suspectedCause;
  if (cause == null) return null;

  return (
    <section className="flex flex-col gap-3 border border-dashed border-border-dim bg-surface-base/40 px-4 py-3">
      <div className="flex flex-col gap-1">
        <h2 className="font-mono text-2xs uppercase tracking-widest text-text-secondary">Suspected cause</h2>
        <p className="text-2xs text-text-secondary">
          A hedged, code-level guess - verify it against the referenced source before acting on it.
        </p>
      </div>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-primary">{cause.explanation}</p>
      <ul className="flex flex-col gap-2">
        {cause.codeReferences.map((reference, index) => (
          <CodeReferenceItem key={`${reference.file}:${reference.lines ?? ""}:${index}`} reference={reference} />
        ))}
      </ul>
    </section>
  );
}

function CodeReferenceItem({ reference }: { reference: CodeReference }) {
  const ref = reference.lines != null ? `${reference.file}:${reference.lines}` : reference.file;
  const hasSnippet = reference.snippet != null && reference.snippet.trim().length > 0;

  return (
    <li className="flex flex-col gap-1.5">
      <CopyableRef value={ref} />
      {hasSnippet && (
        <pre className="overflow-x-auto border border-border-dim bg-surface-void px-3 py-2 font-mono text-xs leading-relaxed text-text-primary">
          <code>{reference.snippet}</code>
        </pre>
      )}
    </li>
  );
}

// The snippet is always shown together with this ref so a reader can jump to the
// source and confirm the excerpt matches - the guess stays verifiable, not authoritative.
function CopyableRef({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPIED_RESET_MS);
    });
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy ${value}`}
      className="group inline-flex w-fit items-center gap-1.5 rounded bg-surface-void px-2 py-1 font-mono text-xs text-text-secondary transition-colors hover:text-text-primary"
    >
      <span>{value}</span>
      {copied ? (
        <CheckIcon size={12} className="text-status-success" />
      ) : (
        <CopyIcon size={12} className="opacity-0 transition-opacity group-hover:opacity-100" />
      )}
    </button>
  );
}
