import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  cn,
} from "@autonoma/blacklight";
import type { AgentHandoffLink } from "@autonoma/types";
import { ArrowUpRightIcon } from "@phosphor-icons/react/ArrowUpRight";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { Claude, Cursor, OpenAI } from "components/icons";
import type { ReactNode } from "react";

type AgentIconComponent = (props: { className?: string }) => ReactNode;
const AGENT_ICONS: Record<string, AgentIconComponent> = {
  "Claude Code": Claude,
  ChatGPT: OpenAI,
  Codex: OpenAI,
  Cursor: Cursor,
};

export function AgentHandoffControls({
  links,
  selectedName,
  onSelect,
  disabled = false,
}: {
  links: AgentHandoffLink[];
  selectedName: string;
  onSelect: (name: string) => void;
  disabled?: boolean;
}) {
  const selected = links.find((link) => link.name === selectedName) ?? links[0];
  if (selected == null) return null;

  return (
    <div className="flex items-center gap-3">
      <AgentPicker links={links} selectedName={selected.name} onSelect={onSelect} />
      {disabled ? (
        <Button variant="cta" size="lg" disabled>
          Open
        </Button>
      ) : (
        <Button
          variant="cta"
          size="lg"
          nativeButton={false}
          render={<a href={selected.href} target="_blank" rel="noreferrer" />}
        >
          Open
          <ArrowUpRightIcon />
        </Button>
      )}
    </div>
  );
}

function AgentPicker({
  links,
  selectedName,
  onSelect,
}: {
  links: AgentHandoffLink[];
  selectedName: string;
  onSelect: (name: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex h-9 items-center gap-2 border border-border-mid bg-surface-void px-3 font-mono text-xs text-text-primary transition-colors hover:bg-surface-raised">
        <AgentIcon name={selectedName} className="size-4 shrink-0" />
        <span className="truncate">{selectedName}</span>
        <CaretDownIcon size={10} className="text-text-secondary" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        {links.map((link) => {
          const isCurrent = link.name === selectedName;
          return (
            <DropdownMenuItem key={link.name} onClick={() => onSelect(link.name)} className="gap-2.5">
              {isCurrent ? (
                <CheckIcon size={13} className="shrink-0 text-primary-ink" />
              ) : (
                <span className="w-[13px] shrink-0" />
              )}
              <AgentIcon name={link.name} className="size-4 shrink-0 text-text-secondary" />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate font-mono text-xs",
                  isCurrent ? "text-text-primary" : "text-text-secondary",
                )}
              >
                {link.name}
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AgentIcon({ name, className }: { name: string; className?: string }) {
  const Icon = AGENT_ICONS[name];
  if (Icon != null) return <Icon className={className} />;
  return <RobotIcon className={cn("size-4", className)} />;
}
