import { type OverlayPoint, ScreenshotWithOverlay, cn } from "@autonoma/blacklight";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useState } from "react";

interface ScreenshotLightboxProps {
  src: string;
  alt: string;
  className?: string;
  points?: Array<OverlayPoint>;
  screenResolution?: { width: number; height: number };
}

export function ScreenshotLightbox({ src, alt, className, points, screenResolution }: ScreenshotLightboxProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) setOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  return (
    <>
      <ScreenshotWithOverlay
        src={src}
        alt={alt}
        imgClassName={cn(className, "cursor-zoom-in")}
        overlaySize="sm"
        points={points}
        screenResolution={screenResolution}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      />

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-100 bg-black/80 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <Dialog.Content
            className="fixed inset-0 z-100 flex items-center justify-center p-8"
            onClick={() => setOpen(false)}
          >
            <Dialog.Title className="sr-only">{alt}</Dialog.Title>
            <Dialog.Description className="sr-only">Expanded screenshot view</Dialog.Description>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="absolute top-4 right-4 z-101 rounded-full bg-black/50 p-2 text-white hover:bg-black/70 transition-colors"
            >
              <X className="size-5" />
            </button>
            <ScreenshotWithOverlay
              src={src}
              alt={alt}
              imgClassName="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
              overlaySize="lg"
              points={points}
              screenResolution={screenResolution}
              onClick={(e) => e.stopPropagation()}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

export interface NavigableStep {
  src: string;
  alt: string;
  points: Array<OverlayPoint>;
  screenResolution?: { width: number; height: number };
  stepNumber: number;
  description: React.ReactNode;
}

interface NavigableLightboxProps {
  steps: NavigableStep[];
  activeIndex: number | undefined;
  onClose: () => void;
  onNavigate: (index: number) => void;
}

export function NavigableLightbox({ steps, activeIndex, onClose, onNavigate }: NavigableLightboxProps) {
  const open = activeIndex != null;
  const step = open ? steps[activeIndex] : undefined;

  const hasPrev = open && activeIndex > 0;
  const hasNext = open && activeIndex < steps.length - 1;

  useEffect(() => {
    if (activeIndex == null) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (activeIndex == null) return;
      if (e.key !== "Escape" && e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      // Capture the key before the surrounding drawer's own dismiss handler (a different dialog library) sees it -
      // otherwise Escape closes the drawer instead of this lightbox, and arrows never reach us.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && activeIndex > 0) onNavigate(activeIndex - 1);
      else if (e.key === "ArrowRight" && activeIndex < steps.length - 1) onNavigate(activeIndex + 1);
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [activeIndex, steps.length, onClose, onNavigate]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-100 bg-black/80 backdrop-blur-sm" onClick={onClose} />
        <Dialog.Content className="fixed inset-0 z-100 flex flex-col items-center justify-center p-8" onClick={onClose}>
          <Dialog.Title className="sr-only">{step?.alt ?? "Screenshot preview"}</Dialog.Title>
          <Dialog.Description className="sr-only">Navigable screenshot preview</Dialog.Description>

          {/* Close button */}
          <button
            type="button"
            onClick={onClose}
            className="absolute top-4 right-4 z-101 rounded-full bg-black/50 p-2 text-white hover:bg-black/70 transition-colors"
          >
            <X className="size-5" />
          </button>

          {step != null && (
            <>
              {/* Step info header */}
              <div
                className="mb-3 flex h-16 flex-col items-center justify-end gap-1 text-white"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="text-sm font-medium text-white/60">
                  Step {step.stepNumber} of {steps.length}
                </span>
                <p className="max-w-xl text-center text-sm leading-snug text-white/90 line-clamp-2">
                  {step.description}
                </p>
              </div>

              {/* Image with navigation arrows */}
              <div className="relative flex items-center gap-4" onClick={(e) => e.stopPropagation()}>
                {/* Previous arrow */}
                <button
                  type="button"
                  onClick={() => {
                    if (hasPrev) onNavigate(activeIndex - 1);
                  }}
                  className={cn(
                    "shrink-0 rounded-full bg-black/50 p-2 text-white transition-colors",
                    hasPrev ? "hover:bg-black/70 cursor-pointer" : "opacity-30 cursor-default",
                  )}
                  disabled={!hasPrev}
                >
                  <ChevronLeft className="size-5" />
                </button>

                <ScreenshotWithOverlay
                  src={step.src}
                  alt={step.alt}
                  imgClassName="max-w-[80vw] max-h-[75vh] object-contain rounded-lg shadow-2xl"
                  overlaySize="lg"
                  points={step.points}
                  screenResolution={step.screenResolution}
                />

                {/* Next arrow */}
                <button
                  type="button"
                  onClick={() => {
                    if (hasNext) onNavigate(activeIndex + 1);
                  }}
                  className={cn(
                    "shrink-0 rounded-full bg-black/50 p-2 text-white transition-colors",
                    hasNext ? "hover:bg-black/70 cursor-pointer" : "opacity-30 cursor-default",
                  )}
                  disabled={!hasNext}
                >
                  <ChevronRight className="size-5" />
                </button>
              </div>

              {/* Keyboard hint */}
              <div className="mt-3 flex items-center gap-3 text-xs text-white/40">
                <span>← → to navigate</span>
                <span>Esc to close</span>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
