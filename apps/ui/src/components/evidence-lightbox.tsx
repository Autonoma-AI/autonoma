import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@autonoma/blacklight";
import { CaretLeftIcon } from "@phosphor-icons/react/CaretLeft";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { XIcon } from "@phosphor-icons/react/X";
import { useEffect } from "react";

export interface EvidenceMediaItem {
  type: "screenshot" | "video";
  url: string;
  description: string;
}

interface EvidenceLightboxProps {
  items: EvidenceMediaItem[];
  activeIndex: number | undefined;
  onClose: () => void;
  onNavigate: (index: number) => void;
}

export function EvidenceLightbox({ items, activeIndex, onClose, onNavigate }: EvidenceLightboxProps) {
  const open = activeIndex != null;
  const current = activeIndex != null ? items[activeIndex] : undefined;
  const hasPrev = activeIndex != null && activeIndex > 0;
  const hasNext = activeIndex != null && activeIndex < items.length - 1;

  // Arrow keys move across the whole evidence gallery, not just within one item.
  useEffect(() => {
    if (activeIndex == null) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft" && activeIndex > 0) onNavigate(activeIndex - 1);
      else if (event.key === "ArrowRight" && activeIndex < items.length - 1) onNavigate(activeIndex + 1);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeIndex, items.length, onNavigate]);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogBackdrop className="bg-black/80" />
      <DialogContent className="flex max-w-none flex-col items-center justify-center border-none bg-transparent p-8 shadow-none">
        <DialogTitle className="sr-only">{current?.description ?? "Evidence"}</DialogTitle>
        <DialogDescription className="sr-only">Evidence preview</DialogDescription>

        <DialogClose
          aria-label="Close"
          className="absolute top-4 right-4 z-10 rounded-full bg-black/50 p-2 text-white transition-colors hover:bg-black/70"
        >
          <XIcon size={20} />
        </DialogClose>

        {current != null && (
          <>
            <p className="mb-3 max-w-xl text-center text-sm leading-snug text-white/90 line-clamp-2">
              {current.description}
            </p>

            <div className="flex items-center gap-4">
              <button
                type="button"
                aria-label="Previous evidence"
                disabled={!hasPrev}
                onClick={() => activeIndex != null && hasPrev && onNavigate(activeIndex - 1)}
                className="rounded-full bg-black/50 p-2 text-white transition-colors hover:bg-black/70 disabled:cursor-not-allowed disabled:opacity-30"
              >
                <CaretLeftIcon size={20} />
              </button>

              {current.type === "screenshot" ? (
                <img
                  src={current.url}
                  alt={current.description}
                  className="max-h-[80vh] max-w-[80vw] rounded-lg object-contain shadow-2xl"
                />
              ) : (
                <video
                  src={current.url}
                  controls
                  autoPlay
                  className="max-h-[80vh] max-w-[80vw] rounded-lg shadow-2xl"
                />
              )}

              <button
                type="button"
                aria-label="Next evidence"
                disabled={!hasNext}
                onClick={() => activeIndex != null && hasNext && onNavigate(activeIndex + 1)}
                className="rounded-full bg-black/50 p-2 text-white transition-colors hover:bg-black/70 disabled:cursor-not-allowed disabled:opacity-30"
              >
                <CaretRightIcon size={20} />
              </button>
            </div>

            <div className="mt-3 text-xs text-white/40">
              {items.length > 1 && activeIndex != null
                ? `${activeIndex + 1} of ${items.length} · ← → to navigate · Esc to close`
                : "Esc to close"}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
