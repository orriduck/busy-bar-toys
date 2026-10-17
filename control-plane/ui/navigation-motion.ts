import { useRef, type RefObject } from "react";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(useGSAP);

/** Move the material, never the hit targets. Interrupted taps keep their position. */
export function useLiquidNavigation(
  scope: RefObject<HTMLElement | null>,
  selectedIndex: number,
) {
  const move = useRef<((immediate?: boolean) => void) | null>(null);

  useGSAP(
    (_context, contextSafe) => {
      const navigation = scope.current;
      const selection = navigation?.querySelector<HTMLElement>(
        ".navigation-selection",
      );
      const material =
        selection?.querySelector<HTMLElement>(".navigation-liquid");
      if (!navigation || !selection || !material || !contextSafe) return;

      const mobile = matchMedia(
        "(max-width: 760px), (max-width: 1023px) and (hover: none) and (pointer: coarse)",
      );
      const reduced = matchMedia(
        "(prefers-reduced-motion: reduce), (forced-colors: active)",
      );
      const place = contextSafe((immediate = false) => {
        const selected = navigation.querySelector<HTMLElement>(
          'button[aria-current="page"]',
        );
        if (!selected) return;
        gsap.killTweensOf([selection, material]);
        if (!mobile.matches) {
          gsap.set(selection, { clearProps: "transform" });
          gsap.set(material, { clearProps: "transform" });
          return;
        }
        // offsetLeft is relative to the same nav padding box as the selection.
        const target =
          selected.offsetLeft - parseFloat(getComputedStyle(selection).left);
        const current = Number(gsap.getProperty(selection, "x"));
        const delta = target - current;
        if (
          immediate ||
          reduced.matches ||
          document.hidden ||
          Math.abs(delta) < 1
        ) {
          gsap.set(selection, { x: target });
          gsap.set(material, { scaleX: 1, scaleY: 1, skewX: 0 });
          return;
        }
        const stretch =
          1.22 + Math.min(Math.abs(delta) / selected.offsetWidth, 3) * 0.1;
        gsap.to(selection, { x: target, duration: 0.54, ease: "expo.out" });
        gsap
          .timeline()
          .to(material, {
            scaleX: stretch,
            scaleY: 0.84,
            skewX: -Math.sign(delta) * 7,
            duration: 0.14,
            ease: "power2.out",
          })
          .to(material, {
            scaleX: 1,
            scaleY: 1,
            skewX: 0,
            duration: 0.4,
            ease: "back.out(1.35)",
          });
      });
      move.current = place;
      place(true);
      const settle = () => place(true);
      const observer = new ResizeObserver(settle);
      observer.observe(navigation);
      mobile.addEventListener("change", settle);
      reduced.addEventListener("change", settle);
      document.addEventListener("visibilitychange", settle);
      return () => {
        move.current = null;
        observer.disconnect();
        mobile.removeEventListener("change", settle);
        reduced.removeEventListener("change", settle);
        document.removeEventListener("visibilitychange", settle);
      };
    },
    { scope },
  );

  useGSAP(
    () => {
      move.current?.();
    },
    { scope, dependencies: [selectedIndex] },
  );
}
