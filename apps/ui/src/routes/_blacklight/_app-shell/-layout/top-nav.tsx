import { AccountMenu } from "./account-menu";
import { AppSwitcher } from "./app-selector";
import { TopNavBar } from "./top-nav-bar";
import { UpgradeButton } from "./upgrade-button";
import { useAppNav } from "./use-app-nav";

/** The application chrome, bound to the application you are looking at. */
export function TopNav({ onFeedback }: { onFeedback: () => void }) {
  const { scope, sections } = useAppNav();
  const isApplicationScope = scope === "application";

  return (
    <TopNavBar
      sections={sections}
      appSwitcher={isApplicationScope ? <AppSwitcher /> : undefined}
      upgrade={<UpgradeButton />}
      account={<AccountMenu onFeedback={onFeedback} />}
    />
  );
}
