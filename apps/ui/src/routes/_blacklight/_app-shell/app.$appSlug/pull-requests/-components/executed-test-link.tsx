import type { ReactNode } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

interface ExecutedTestLinkTarget {
  runId: string | null;
  generationId: string | null;
  testCase: { slug: string };
}

interface ExecutedTestLinkProps {
  test: ExecutedTestLinkTarget;
  className: string;
  children: ReactNode;
}

/**
 * Resolves an executed test to its result page. A test that ran links to its run, one that
 * only generated links to its generation, and anything else falls back to the test definition.
 */
export function ExecutedTestLink({ test, className, children }: ExecutedTestLinkProps) {
  if (test.runId != null) {
    return (
      <AppLink to="/app/$appSlug/runs/$runId" params={{ runId: test.runId }} className={className}>
        {children}
      </AppLink>
    );
  }

  if (test.generationId != null) {
    return (
      <AppLink
        to="/app/$appSlug/generations/$generationId"
        params={{ generationId: test.generationId }}
        className={className}
      >
        {children}
      </AppLink>
    );
  }

  return (
    <AppLink to="/app/$appSlug/tests/$testSlug" params={{ testSlug: test.testCase.slug }} className={className}>
      {children}
    </AppLink>
  );
}
