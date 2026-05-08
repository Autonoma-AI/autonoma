import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { LightbulbIcon } from "@phosphor-icons/react/Lightbulb";
import { useState } from "react";
import Markdown from "react-markdown";

interface ReasoningBlockProps {
  label: string;
  content: string;
}

export function ReasoningBlock({ label, content }: ReasoningBlockProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-border-dim bg-surface-base">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-surface-raised/40"
      >
        <LightbulbIcon size={12} className="text-text-tertiary" />
        <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-tertiary">{label}</span>
        <CaretDownIcon
          size={12}
          className={`ml-auto text-text-tertiary transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      {expanded && (
        <div className="border-t border-border-dim px-4 py-3">
          <article className="prose prose-sm prose-invert max-w-none">
            <Markdown
              components={{
                h1: ({ children }) => (
                  <h1 className="mb-3 border-b border-border-dim pb-2 text-base font-semibold text-text-primary">
                    {children}
                  </h1>
                ),
                h2: ({ children }) => <h2 className="mb-2 mt-5 text-sm font-semibold text-text-primary">{children}</h2>,
                h3: ({ children }) => <h3 className="mb-1.5 mt-4 text-sm font-medium text-text-primary">{children}</h3>,
                p: ({ children }) => <p className="mb-3 text-sm leading-relaxed text-text-secondary">{children}</p>,
                strong: ({ children }) => <strong className="font-semibold text-text-primary">{children}</strong>,
                code: ({ children }) => (
                  <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-xs text-text-primary">
                    {children}
                  </code>
                ),
                ul: ({ children }) => (
                  <ul className="mb-3 list-inside list-disc space-y-1 text-sm text-text-secondary">{children}</ul>
                ),
                ol: ({ children }) => (
                  <ol className="mb-3 list-inside list-decimal space-y-1 text-sm text-text-secondary">{children}</ol>
                ),
                li: ({ children }) => <li className="text-sm text-text-secondary">{children}</li>,
              }}
            >
              {content}
            </Markdown>
          </article>
        </div>
      )}
    </div>
  );
}
