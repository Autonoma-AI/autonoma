import Markdown from "react-markdown";

/**
 * A test plan rendered as markdown. Plans are authored in markdown (`**Setup**`, bullet steps, backtick code
 * spans), so the raw source belongs behind a renderer everywhere it is shown at rest - the generation page and
 * the finding drawer's plan tab. The one place plans stay monospace is a diff, where the line-for-line source
 * is the point.
 */
export function PlanMarkdown({ content }: { content: string }) {
  return (
    <article className="prose prose-sm prose-invert max-w-none">
      <Markdown
        components={{
          h1: ({ children }) => (
            <h1 className="mb-3 border-b border-border-dim pb-2 text-base font-semibold text-text-primary">
              {children}
            </h1>
          ),
          h2: ({ children }) => <h2 className="mt-5 mb-2 text-sm font-semibold text-text-primary">{children}</h2>,
          h3: ({ children }) => <h3 className="mt-4 mb-1.5 text-sm font-medium text-text-primary">{children}</h3>,
          p: ({ children }) => <p className="mb-3 text-sm leading-relaxed text-text-primary">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold text-text-primary">{children}</strong>,
          code: ({ children }) => (
            <code className="rounded bg-surface-base px-1.5 py-0.5 font-mono text-xs text-text-primary">
              {children}
            </code>
          ),
          ul: ({ children }) => (
            <ul className="mb-3 list-inside list-disc space-y-1 text-sm text-text-primary">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-3 list-inside list-decimal space-y-1 text-sm text-text-primary">{children}</ol>
          ),
          li: ({ children }) => <li className="text-sm text-text-primary">{children}</li>,
          a: ({ href, children }) => (
            <a
              href={href}
              className="text-primary-ink underline underline-offset-2 hover:text-primary-ink/80"
              target="_blank"
              rel="noopener noreferrer"
            >
              {children}
            </a>
          ),
          hr: () => <hr className="my-4 border-border-dim" />,
        }}
      >
        {content}
      </Markdown>
    </article>
  );
}
