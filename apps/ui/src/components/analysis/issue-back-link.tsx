import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

const CLASS_NAME =
  "inline-flex size-5 shrink-0 items-center justify-center rounded text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary";

/**
 * Back to the branch surface an issue was reached from: its pull request, or the main-branch page when the issue
 * lives on main (which has no pull request, so no PR number to route by).
 */
export function IssueBackLink({ prNumber }: { prNumber?: number }) {
  if (prNumber == null) {
    return (
      <AppLink to="/app/$appSlug/pull-requests/main" aria-label="Back to the main branch" className={CLASS_NAME}>
        <ArrowLeftIcon size={12} />
      </AppLink>
    );
  }

  return (
    <AppLink
      to="/app/$appSlug/pull-requests/$prNumber"
      params={{ prNumber }}
      aria-label="Back to the pull request"
      className={CLASS_NAME}
    >
      <ArrowLeftIcon size={12} />
    </AppLink>
  );
}
