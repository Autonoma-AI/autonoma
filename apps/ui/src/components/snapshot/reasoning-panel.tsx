import { Panel, PanelBody, PanelHeader, PanelTitle } from "@autonoma/blacklight";
import { ReasoningMarkdown } from "./reasoning-block";

/** A titled panel that renders a markdown reasoning narrative, or a muted empty message when there is none. */
export function ReasoningPanel({ title, content, empty }: { title: string; content?: string; empty: string }) {
  const hasContent = content != null && content.trim().length > 0;

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>{title}</PanelTitle>
      </PanelHeader>
      <PanelBody>
        {hasContent ? <ReasoningMarkdown content={content} /> : <p className="text-xs text-text-secondary">{empty}</p>}
      </PanelBody>
    </Panel>
  );
}
