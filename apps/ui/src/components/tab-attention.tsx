import { useState, useSyncExternalStore } from "react";

/**
 * Favicon shown while attention is demanded: brand-dark tile with a red
 * notification dot. A precomputed data URI (no canvas, no async) so it renders
 * declaratively like any other prop.
 */
const ATTENTION_FAVICON = `data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>" +
    "<rect width='64' height='64' rx='14' fill='#050505'/>" +
    "<circle cx='42' cy='22' r='16' fill='#f43f5e'/>" +
    "</svg>",
)}`;

/**
 * Declarative "this tab needs you" indicator. While `message` is set and the
 * user is NOT looking at the tab, it renders a `<title>` and favicon `<link>`
 * (React 19 hoists both into `<head>`, and removes them on unmount - restoring
 * the originals). The moment the tab gains focus the message is marked seen and
 * everything reverts; the same message never re-alerts.
 *
 * Purely presentational - callers decide WHEN attention is needed by passing
 * `message`, and layer sounds/notifications on top themselves.
 */
export function TabAttention({ message }: { message?: string }) {
  const focused = useTabFocused();
  // "Seen" bookkeeping: a message the user was focused for (or focused onto) is
  // acknowledged. Adjusting state during render is React's sanctioned pattern
  // for deriving state from the previous render - no effects involved.
  const [seenMessage, setSeenMessage] = useState<string | undefined>(undefined);
  if (focused && message != null && seenMessage !== message) {
    setSeenMessage(message);
  }

  const active = message != null && message !== seenMessage;
  if (!active) return undefined;

  return (
    <>
      <title>{`● ${message}`}</title>
      <link rel="icon" href={ATTENTION_FAVICON} />
    </>
  );
}

/** Whether the tab is focused and visible, as an external-store subscription (the React way to read DOM state). */
function useTabFocused(): boolean {
  return useSyncExternalStore(subscribeToFocus, readFocused);
}

function subscribeToFocus(onChange: () => void): () => void {
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onChange);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onChange);
    document.removeEventListener("visibilitychange", onChange);
  };
}

function readFocused(): boolean {
  return document.hasFocus() && document.visibilityState === "visible";
}
