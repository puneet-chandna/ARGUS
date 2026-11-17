import { flushSync } from "react-dom";
import { useCallback, useEffect, useRef } from "react";

const easeOut = "cubic-bezier(.23, 1, .32, 1)";

export function useAnalysisMotion() {
  const transition = useRef<ViewTransition>(undefined);
  const fallback = useRef<(() => void) | undefined>(undefined);
  const generation = useRef(0);
  const interrupt = useCallback(() => {
    generation.current++;
    transition.current?.skipTransition();
    fallback.current?.();
    transition.current = undefined;
    fallback.current = undefined;
    delete document.documentElement.dataset.argusTransition;
  }, []);
  useEffect(() => {
    window.addEventListener("pagehide", interrupt);
    return () => { window.removeEventListener("pagehide", interrupt); interrupt(); };
  }, [interrupt]);

  const swap = useCallback(async (kind: "live" | "instant" | "complete", render: () => void, valid: () => boolean) => {
    interrupt();
    const version = generation.current;
    const current = () => version === generation.current && valid();
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!current()) return false;
    const commit = () => { if (current()) flushSync(render); };
    if (document.hidden) commit();
    else if (!reduced && document.startViewTransition) {
      document.documentElement.dataset.argusTransition = kind;
      try {
        const pending = document.startViewTransition(commit);
        transition.current = pending;
        await pending.finished;
      } catch { commit(); }
      finally {
        if (current()) {
          transition.current = undefined;
          delete document.documentElement.dataset.argusTransition;
        }
      }
    } else {
      const duration = reduced ? 120 : 180;
      const region = document.querySelector<HTMLElement>(".analysis-region");
      const card = () => region?.querySelector<HTMLElement>(".analysis-entry > .analysis-card, .analysis-preload[data-preload='false'] > .analysis-card");
      const previous = card();
      let outgoing: HTMLElement | undefined;
      if (region && previous?.animate) {
        const before = previous.getBoundingClientRect();
        const origin = region.getBoundingClientRect();
        outgoing = previous.cloneNode(true) as HTMLElement;
        outgoing.inert = true;
        outgoing.setAttribute("aria-hidden", "true");
        for (const element of outgoing.querySelectorAll("[id]")) element.removeAttribute("id");
        Object.assign(outgoing.style, {
          position: "absolute", left: `${before.left - origin.left}px`, top: `${before.top - origin.top}px`,
          width: `${before.width}px`, height: `${before.height}px`, margin: "0", zIndex: "1",
          pointerEvents: "none", viewTransitionName: "none",
        });
      }
      commit();
      if (!current()) return false;
      if (outgoing) region?.append(outgoing);
      const options = { duration, easing: easeOut, fill: "both" } as const;
      const exit = outgoing?.animate([{ opacity: 1 }, { opacity: 0 }], options);
      const enter = card()?.animate?.([{ opacity: 0 }, { opacity: 1 }], options);
      const cleanup = () => { exit?.cancel(); enter?.cancel(); outgoing?.remove(); };
      fallback.current = cleanup;
      await Promise.allSettled([exit?.finished, enter?.finished]);
      cleanup();
      if (current()) fallback.current = undefined;
    }
    return current();
  }, [interrupt]);
  return { swap, interrupt };
}

// requestAnimationFrame is only used to let preloaded content settle before the one-off handoff.
export async function paintResult() {
  await document.fonts?.ready;
  if (document.hidden) return;
  await new Promise<void>(resolve => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(finish);
    });
    function finish() {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", finish);
      resolve();
    }
    document.addEventListener("visibilitychange", finish, { once: true });
  });
}
