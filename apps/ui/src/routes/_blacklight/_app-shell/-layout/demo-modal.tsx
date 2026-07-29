import {
  Button,
  Dialog,
  DialogBackdrop,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@autonoma/blacklight";
import { demoModalStore } from "lib/demo-modal-store";
import { useSyncExternalStore } from "react";
import { DemoSignupButton } from "./demo-signup-button";

/**
 * The conversion modal. Opened globally by the tRPC `MutationCache.onError` whenever a
 * mutation is rejected by the demo write-block (see `demo-read-only-error`), so a click on
 * any mutating control in the demo lands here instead of failing with a toast. Mounted
 * once in the app shell; controlled entirely by `demoModalStore`.
 */
export function DemoModal() {
  const open = useSyncExternalStore(demoModalStore.subscribe, demoModalStore.getSnapshot);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? demoModalStore.open() : demoModalStore.close())}>
      <DialogBackdrop />
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>This is a demo</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-5">
          <p className="text-sm text-text-secondary">
            You're exploring a read-only demo, so changes are disabled here. Sign up free to run tests, review your own
            pull requests, and catch real bugs on your app.
          </p>
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => demoModalStore.close()}>
              Keep exploring
            </Button>
            <DemoSignupButton />
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
