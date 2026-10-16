import { createContext, useContext, useRef, useSyncExternalStore } from "react";
import type { ReactNode, RefObject } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { listMotion, motionTiming, type RowPosition } from "./motion-model";
import { measuredMotionScope } from "./motion-scope";

gsap.registerPlugin(useGSAP);

const MotionContext = createContext({ active: false, enabled: false });
export const useMotion = () => useContext(MotionContext);

function subscribeMotion(update: () => void) {
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  preference.addEventListener("change", update);
  document.addEventListener("visibilitychange", update);
  return () => {
    preference.removeEventListener("change", update);
    document.removeEventListener("visibilitychange", update);
  };
}
const motionEnvironment = () =>
  `${document.hidden}:${window.matchMedia("(prefers-reduced-motion: reduce)").matches}`;

/** Keeps pages mounted: navigation never discards drafts or the live preview. */
export function MotionPage({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const scope = useRef<HTMLDivElement>(null);
  const visited = useRef(false);
  const wasActive = useRef(false);
  const environment = useSyncExternalStore(
    subscribeMotion,
    motionEnvironment,
    () => "true:true",
  );
  const visible = active && !environment.startsWith("true:");
  const enabled = visible && environment.endsWith(":false");
  useGSAP(
    () => {
      if (!active) {
        wasActive.current = false;
        return;
      }
      const arrival = !wasActive.current;
      wasActive.current = true;
      const first = !visited.current;
      visited.current = true;
      if (!arrival || !enabled) return;
      gsap.fromTo(
        scope.current,
        { opacity: 0.65, y: first ? 8 : 0 },
        {
          opacity: 1,
          y: 0,
          duration: first ? motionTiming.page : motionTiming.return,
          ease: "power3.out",
          clearProps: "opacity,transform",
        },
      );
    },
    { scope, dependencies: [active, enabled], revertOnUpdate: true },
  );
  return (
    <MotionContext.Provider value={{ active: visible, enabled }}>
      <div ref={scope} className="page-slot" hidden={!active}>
        {children}
      </div>
    </MotionContext.Provider>
  );
}

/** Only structural changes trigger measurement; a payload/progress tick does not. */
export function useListMotion(
  scope: RefObject<HTMLElement | null>,
  signature: string,
  blocked = false,
  selector = "[data-motion-row]",
) {
  const { active, enabled } = useMotion();
  const previous = useRef<Map<string, RowPosition> | null>(null);
  const visited = useRef(false);
  const wasBlocked = useRef(false);
  useGSAP(
    (context) => {
      const root = scope.current;
      if (!root || !active) {
        previous.current = null;
        return;
      }
      const rootTop = root.getBoundingClientRect().top;
      const elements = Array.from(root.querySelectorAll<HTMLElement>(selector));
      const positions = elements.map((element) => ({
        id: (element.dataset.motionRow ?? element.dataset.motionGroup)!,
        top: element.getBoundingClientRect().top - rootTop,
        offset: 0,
        opacity: 1,
      }));
      const before = previous.current;
      const first = !visited.current;
      visited.current = true;
      const interruptedDrag = wasBlocked.current;
      wasBlocked.current = blocked;
      const current = new Map(
        positions.map((position) => [position.id, position]),
      );
      previous.current = current;
      // Returning to a page or leaving a drag starts from its actual current layout.
      const plans = listMotion(before ?? new Map(), positions, {
        enabled:
          enabled && !blocked && !interruptedDrag && (Boolean(before) || first),
        first,
      });
      const revert = measuredMotionScope(context, () => {
        for (const plan of plans) {
          const element = elements.find(
            (node) =>
              (node.dataset.motionRow ?? node.dataset.motionGroup) === plan.id,
          )!;
          const position = current.get(plan.id)!;
          position.offset = plan.y;
          position.opacity = plan.opacity;
          gsap.fromTo(
            element,
            { y: plan.y, opacity: plan.opacity },
            {
              y: 0,
              opacity: 1,
              delay: plan.delay,
              duration: plan.duration,
              ease: "power3.out",
              clearProps: "opacity,transform",
              // Record the in-flight offset before useGSAP reverts on the next change.
              // Reconciliation can resume at that visual position without copying DOM.
              onUpdate: () => {
                position.offset = Number(gsap.getProperty(element, "y"));
                position.opacity = Number(gsap.getProperty(element, "opacity"));
              },
              onComplete: () => {
                position.offset = 0;
                position.opacity = 1;
              },
            },
          );
        }
      });
      // Disclosure, wrapping and viewport changes can move rows without a new ID.
      // Keep the baseline current without creating an animation for those updates.
      const observer = new ResizeObserver(() => {
        const top = root.getBoundingClientRect().top;
        elements.forEach((element, index) => {
          positions[index].top =
            element.getBoundingClientRect().top -
            top -
            Number(gsap.getProperty(element, "y"));
        });
      });
      observer.observe(root);
      return () => {
        observer.disconnect();
        revert();
      };
    },
    {
      scope,
      dependencies: [signature, active, enabled, blocked, selector],
      revertOnUpdate: true,
    },
  );
}

export function useSemanticMotion(
  scope: RefObject<HTMLElement | null>,
  value: string | number,
  fade = false,
) {
  const { enabled } = useMotion();
  const previous = useRef(value);
  useGSAP(
    () => {
      const changed = previous.current !== value;
      previous.current = value;
      if (!enabled || !changed) return;
      gsap.fromTo(
        scope.current,
        { "--motion-flash": 0.14, ...(fade ? { opacity: 0.65 } : {}) },
        {
          "--motion-flash": 0,
          ...(fade ? { opacity: 1 } : {}),
          duration: 0.28,
          ease: "power2.out",
          clearProps: fade ? "opacity,--motion-flash" : "--motion-flash",
        },
      );
    },
    { scope, dependencies: [value, enabled, fade], revertOnUpdate: true },
  );
}

export function MotionFeedback({
  value,
  children,
}: {
  value: string | number;
  children: ReactNode;
}) {
  const scope = useRef<HTMLSpanElement>(null);
  useSemanticMotion(scope, value, true);
  return (
    <span ref={scope} className="motion-feedback">
      {children}
    </span>
  );
}

export function MotionReveal({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const scope = useRef<HTMLDivElement>(null);
  const { enabled } = useMotion();
  const entered = useRef(false);
  useGSAP(
    () => {
      if (entered.current || !enabled) return;
      entered.current = true;
      gsap.fromTo(
        scope.current,
        { opacity: 0.55, y: 4 },
        {
          opacity: 1,
          y: 0,
          duration: 0.18,
          ease: "power3.out",
          clearProps: "opacity,transform",
        },
      );
    },
    { scope, dependencies: [enabled], revertOnUpdate: true },
  );
  return (
    <div ref={scope} className={className}>
      {children}
    </div>
  );
}
