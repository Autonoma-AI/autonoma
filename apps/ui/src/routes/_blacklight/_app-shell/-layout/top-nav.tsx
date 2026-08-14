import { useRouteContext } from "@tanstack/react-router";
import { AccountMenu } from "./account-menu";
import { AppSwitcher } from "./app-selector";
import { OrgSwitcher } from "./org-switcher";
import { TopNavBar } from "./top-nav-bar";
import { UpgradeButton } from "./upgrade-button";
import { useAppNav } from "./use-app-nav";

/** The application chrome, bound to the application you are looking at. */
export function TopNav({ onFeedback }: { onFeedback: () => void }) {
  const { scope, sections } = useAppNav();
  const activeOrganization = useRouteContext({
    from: "/_blacklight/_app-shell",
    select: (ctx) => ctx.activeOrganization,
  });
  const isApplicationScope = scope === "application";

  return (
    <TopNavBar
      sections={sections}
      orgSwitcher={<OrgSwitcher activeOrganizationName={activeOrganization.name} />}
      appSwitcher={isApplicationScope ? <AppSwitcher /> : undefined}
      upgrade={<UpgradeButton />}
      account={<AccountMenu onFeedback={onFeedback} />}
    />
  );
}
