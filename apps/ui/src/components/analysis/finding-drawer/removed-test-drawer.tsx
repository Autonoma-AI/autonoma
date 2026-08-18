import { Drawer, DrawerClose, DrawerContent } from "@autonoma/blacklight";
import type { AnalysisRunRemovedTest } from "@autonoma/types";
import { XIcon } from "@phosphor-icons/react/X";
import { FindingDrawerPlan } from "./finding-drawer-plan";

/**
 * The stub drawer for a test this checkpoint removed without ever selecting it: no finding, no run - the
 * identity, the reason it is gone, and the plan that was deleted are all there is to show.
 */
export function RemovedTestDrawer({ removed, onClose }: { removed: AnalysisRunRemovedTest; onClose: () => void }) {
  return (
    <Drawer side="right" modal={false} open onOpenChange={(open) => !open && onClose()}>
      <DrawerContent side="right" className="flex w-160 max-w-[95vw] flex-col gap-0 overflow-hidden p-0 font-sans">
        <header className="flex shrink-0 flex-col gap-2 border-b border-border-dim px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-base font-semibold text-text-primary">{removed.testCase.name}</h2>
            <DrawerClose className="text-text-secondary transition-colors hover:text-text-primary" aria-label="Close">
              <XIcon size={16} />
            </DrawerClose>
          </div>
          <p className="text-sm text-text-primary">
            Removed by this checkpoint's changes - the test was never selected to run.
          </p>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="flex flex-col gap-2">
            <h3 className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-secondary">
              The deleted plan
            </h3>
            <FindingDrawerPlan plan={removed.previousPlan} />
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
