import type { ReactNode } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

interface ExecutedTestLinkTarget {
  generationId: string | null;
  testCase: { slug: string };
}

interface ExecutedTestLinkProps {
  test: ExecutedTestLinkTarget;
  className: string;
  children: ReactNode;
}

/**
 * Resolves an executed test to its result page. A test that generated links to its generation;
 * anything else falls back to the test definition.
 */
export function ExecutedTestLink({ test, className, children }: ExecutedTestLinkProps) {
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
