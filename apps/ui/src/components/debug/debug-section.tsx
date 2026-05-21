import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { useState } from "react";

interface DebugSectionProps {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  badge?: React.ReactNode;
}

export function DebugSection({ icon, title, children, defaultOpen = false, badge }: DebugSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border border-border-dim bg-surface-base">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-surface-raised/40"
      >
        {icon}
        <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-tertiary">{title}</span>
        {badge}
        <CaretDownIcon
          size={12}
          className={`ml-auto text-text-tertiary transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && <div className="border-t border-border-dim px-4 py-3">{children}</div>}
    </div>
  );
}
