import { Button, cn } from "@autonoma/blacklight";
import { buildAgentHandoffLinks, MAX_DEEP_LINK_PROMPT_CHARS, type AgentHandoffLink } from "@autonoma/types";
import { CaretUpIcon } from "@phosphor-icons/react/CaretUp";
import { AgentHandoffControls } from "components/analysis/fix/agent-handoff-controls";
import { CopyPromptButton } from "components/analysis/fix/copy-prompt-button";
import { FixPromptPanel } from "components/analysis/fix/fix-prompt-panel";
import { useState } from "react";

const STORED_AGENT_KEY = "autonoma:fix-agent";

export interface FixActionBarProps {
  prompt: string;
  /** The condensed brief the deep-links can hold. */
  linkPrompt: string;
  selectedCount: number;
  repoFullName?: string;
}

export function FixActionBar({ prompt, linkPrompt, selectedCount, repoFullName }: FixActionBarProps) {
  const links = buildAgentHandoffLinks(linkPrompt, repoFullName);
  const [promptOpen, setPromptOpen] = useState(false);
  const [agentName, setAgentName] = useState<string | undefined>(() => readStoredAgent(links) ?? links[0]?.name);
  const isEmpty = selectedCount === 0;
  const selected = links.find((link) => link.name === agentName) ?? links[0];
  if (selected == null) return null;

  function selectAgent(name: string) {
    setAgentName(name);
    writeStoredAgent(name);
  }

  return (
    <div className="flex flex-col">
      {promptOpen && !isEmpty && (
        <FixPromptPanel
          prompt={prompt}
          condensed={linkPrompt.length < prompt.length}
          truncated={linkPrompt.length > MAX_DEEP_LINK_PROMPT_CHARS}
        />
      )}

      {/* Pinned like the preview config's save bar: the issue rows expand in place, so the button the reader
          came for must not walk off the bottom of the page as they read. */}
      <section className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border border-border-dim bg-surface-base/95 px-6 py-5 backdrop-blur">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5"
          onClick={() => setPromptOpen((prev) => !prev)}
          aria-expanded={promptOpen}
          disabled={isEmpty}
        >
          <CaretUpIcon size={12} weight="bold" className={cn("transition-transform", promptOpen && "rotate-180")} />
          {promptOpen ? "Hide full prompt" : "View full prompt"}
        </Button>
        <CopyPromptButton prompt={prompt} disabled={isEmpty} />

        <div className="ml-auto flex flex-wrap items-center gap-3">
          <span className="font-mono text-2xs uppercase tracking-widest text-text-secondary">
            {isEmpty ? "Select an issue to send" : `Send ${describeCount(selectedCount)}`}
          </span>
          <AgentHandoffControls links={links} selectedName={selected.name} onSelect={selectAgent} disabled={isEmpty} />
        </div>
      </section>
    </div>
  );
}

function describeCount(count: number): string {
  return `${count} ${count === 1 ? "issue" : "issues"}`;
}

function readStoredAgent(links: AgentHandoffLink[]): string | undefined {
  try {
    const stored = localStorage.getItem(STORED_AGENT_KEY);
    if (stored == null) return undefined;
    return links.some((link) => link.name === stored) ? stored : undefined;
  } catch (err) {
    console.debug("Failed to read the stored fix agent", err);
    return undefined;
  }
}

function writeStoredAgent(name: string): void {
  try {
    localStorage.setItem(STORED_AGENT_KEY, name);
  } catch (err) {
    console.debug("Failed to persist the fix agent", err);
  }
}
