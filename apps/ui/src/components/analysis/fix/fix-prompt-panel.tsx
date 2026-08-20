import { cn } from "@autonoma/blacklight";

export interface FixPromptPanelProps {
  prompt: string;
  /** True when the deep-links carry a shortened brief, so the panel can say Open sends less than Copy. */
  condensed: boolean;
  /**
   * True when condensing was not enough and the deep-link brief was also cut at the URL ceiling. Said separately
   * because the cut takes the TAIL: it drops whichever selected issues sort last rather than trimming detail
   * evenly, so Copy stops being the nicer option and becomes the only one that sends everything.
   */
  truncated: boolean;
  className?: string;
}

export function FixPromptPanel({ prompt, condensed, truncated, className }: FixPromptPanelProps) {
  return (
    <div className={cn("flex flex-col gap-3 border border-b-0 border-border-dim bg-surface-base px-6 py-5", className)}>
      <p className="text-sm text-text-secondary">This is what Copy the prompt puts on your clipboard.</p>
      {condensed && !truncated && (
        <p className="text-sm text-text-secondary">Open sends a shorter version, without the report or the code.</p>
      )}
      {truncated && (
        <p className="text-sm text-status-warn">Open cannot fit all of this - it would drop the last issues.</p>
      )}
      <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap border border-border-dim bg-surface-void p-4 font-mono text-2xs leading-relaxed text-text-secondary">
        {prompt}
      </pre>
    </div>
  );
}
