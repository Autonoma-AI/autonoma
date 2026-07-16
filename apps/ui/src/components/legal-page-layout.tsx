import type { ReactNode } from "react";

interface LegalPageLayoutProps {
  title: string;
  lastUpdated: string;
  children: ReactNode;
}

/** Shared shell for standalone legal pages (privacy, terms, EULA) - no app shell, no auth. */
export function LegalPageLayout({ title, lastUpdated, children }: LegalPageLayoutProps) {
  return (
    <div className="min-h-dvh bg-surface-void">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-3xl font-semibold tracking-tight text-text-primary">{title}</h1>
        <p className="mt-2 text-sm text-text-secondary">Last updated: {lastUpdated}</p>
        <div className="mt-10 flex flex-col gap-4">{children}</div>
      </div>
    </div>
  );
}

export function LegalSection({ children }: { children: ReactNode }) {
  return <section className="flex flex-col gap-3">{children}</section>;
}

export function LegalH2({ children }: { children: ReactNode }) {
  return <h2 className="mt-6 text-xl font-semibold text-text-primary">{children}</h2>;
}

export function LegalH3({ children }: { children: ReactNode }) {
  return <h3 className="mt-2 text-lg font-medium text-text-primary">{children}</h3>;
}

export function LegalH4({ children }: { children: ReactNode }) {
  return <h4 className="text-base font-medium text-text-primary">{children}</h4>;
}

export function LegalP({ children }: { children: ReactNode }) {
  return <p className="leading-relaxed text-text-secondary">{children}</p>;
}

export function LegalUL({ children }: { children: ReactNode }) {
  return <ul className="flex list-disc flex-col gap-2 pl-6 leading-relaxed text-text-secondary">{children}</ul>;
}

export function LegalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline hover:text-primary/80">
      {children}
    </a>
  );
}
