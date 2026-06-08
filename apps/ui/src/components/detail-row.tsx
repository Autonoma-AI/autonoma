/** A labeled value row used in detail-page sidebars: a small uppercase label above its content. */
export function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-tertiary">{label}</span>
      <div className="text-sm text-text-secondary">{children}</div>
    </div>
  );
}
