import {
  Button,
  Dialog,
  DialogBackdrop,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Textarea,
} from "@autonoma/blacklight";
import { useRerunGeneration } from "lib/query/generations.queries";
import { useState } from "react";
import { useAppNavigate } from "../../../-use-app-navigate";

interface RerunGenerationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  generationId: string;
  currentPlan: string;
}

type Mode = "same" | "update";

export function RerunGenerationDialog({ open, onOpenChange, generationId, currentPlan }: RerunGenerationDialogProps) {
  const rerun = useRerunGeneration();
  const navigate = useAppNavigate();
  const [mode, setMode] = useState<Mode>("same");
  const [plan, setPlan] = useState(currentPlan);

  function handleOpenChange(nextOpen: boolean) {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setMode("same");
      setPlan(currentPlan);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    rerun.mutate(
      {
        generationId,
        planContent: mode === "update" ? plan : undefined,
      },
      {
        onSuccess: ({ generationId: newGenerationId }) => {
          onOpenChange(false);
          void navigate({
            to: "/app/$appSlug/generations/$generationId",
            params: { generationId: newGenerationId },
          });
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogBackdrop />
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Re-run generation</DialogTitle>
          </DialogHeader>

          <DialogBody className="flex flex-col gap-4">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setMode("same")}
                className={`flex-1 border px-4 py-3 text-left text-sm transition-colors ${
                  mode === "same"
                    ? "border-primary bg-primary/5 text-text-primary"
                    : "border-border-dim text-text-secondary hover:border-border-mid hover:text-text-primary"
                }`}
              >
                <p className="font-medium">Same plan</p>
                <p className="mt-0.5 font-mono text-2xs text-text-tertiary">Re-run with the existing plan</p>
              </button>
              <button
                type="button"
                onClick={() => setMode("update")}
                className={`flex-1 border px-4 py-3 text-left text-sm transition-colors ${
                  mode === "update"
                    ? "border-primary bg-primary/5 text-text-primary"
                    : "border-border-dim text-text-secondary hover:border-border-mid hover:text-text-primary"
                }`}
              >
                <p className="font-medium">Update plan</p>
                <p className="mt-0.5 font-mono text-2xs text-text-tertiary">Edit the plan before re-running</p>
              </button>
            </div>

            {mode === "update" && (
              <Textarea
                value={plan}
                onChange={(e) => setPlan(e.target.value)}
                className="min-h-48 resize-none font-mono text-xs"
                autoFocus
              />
            )}
          </DialogBody>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" disabled={rerun.isPending || (mode === "update" && plan.trim() === "")}>
              {rerun.isPending ? "Running..." : "Re-run"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
