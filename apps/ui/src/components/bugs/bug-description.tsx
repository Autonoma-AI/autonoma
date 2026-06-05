import { ReasoningMarkdown } from "../snapshot/reasoning-block";

interface BugDescriptionProps {
  description: string;
}

export function BugDescription({ description }: BugDescriptionProps) {
  const content = normalizeBugDescriptionMarkdown(description);
  if (content === "") return null;

  return (
    <div className="mt-3 max-w-5xl">
      <ReasoningMarkdown content={content} />
    </div>
  );
}

export function normalizeBugDescriptionMarkdown(description: string): string {
  return description
    .replace(/\r\n/g, "\n")
    .trim()
    .replace(/[ \t]+(#{1,6}\s+)/g, "\n\n$1")
    .replace(/(^|\n)(#{1,6}\s+Affected files)\s*[-:]\s*/gi, "$1$2\n\n")
    .replace(/(^|\n)(#{1,6}\s+Suggested fix)\s+/gi, "$1$2\n\n");
}
