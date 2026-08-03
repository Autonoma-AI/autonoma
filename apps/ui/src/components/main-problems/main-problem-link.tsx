import type { MainProblemSource } from "@autonoma/types";
import type { ReactNode } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

interface MainProblemLinkProps {
  problemId: string;
  source: MainProblemSource;
  className: string;
  children: ReactNode;
}

/**
 * Routes one of main's open problems to its own detail page. The store the API resolved the problem from is the
 * only thing either main-problems surface has to know about the legacy/authoritative fork: a legacy bug has a bug
 * page, an analysis issue has an issue page.
 */
export function MainProblemLink({ problemId, source, className, children }: MainProblemLinkProps) {
  if (source === "legacy_bug") {
    return (
      <AppLink to="/app/$appSlug/bugs/$bugId" params={{ bugId: problemId }} className={className}>
        {children}
      </AppLink>
    );
  }

  return (
    <AppLink to="/app/$appSlug/analysis/issues/$issueId" params={{ issueId: problemId }} className={className}>
      {children}
    </AppLink>
  );
}
