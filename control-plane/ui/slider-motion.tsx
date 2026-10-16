import { useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(useGSAP);
export type SliderMeaning = "priority" | "hold" | "later" | "heartbeat";

/** Decorative cues only; the Slider owns all values, input and semantics. */
export function SliderMotion({ meaning }: { meaning: SliderMeaning }) {
  const scope = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const media = gsap.matchMedia();
      media.add("(prefers-reduced-motion: no-preference)", () => {
        const root = scope.current;
        if (!root) return;
        const timeline = gsap.timeline({ paused: true, repeat: -1 });
        if (meaning === "priority") {
          timeline
            .fromTo(
              "[data-bubble]",
              { y: 9, opacity: 0, scale: 0.5 },
              {
                y: -10,
                opacity: 0.55,
                scale: 1,
                duration: 2.4,
                stagger: { each: 0.25, from: "start" },
                ease: "sine.inOut",
              },
            )
            .to("[data-bubble]", { opacity: 0, duration: 0.6, stagger: 0.1 });
        } else if (meaning === "hold") {
          timeline
            .fromTo(
              "[data-beam]",
              { xPercent: -100, opacity: 0 },
              {
                xPercent: 400,
                opacity: 0.45,
                duration: 2.6,
                ease: "power3.out",
              },
            )
            .to("[data-beam]", { opacity: 0, duration: 0.6 }, "+=0.7");
        } else if (meaning === "later") {
          timeline
            .fromTo(
              "[data-later]",
              { xPercent: -5, opacity: 0 },
              {
                xPercent: 90,
                opacity: 0.4,
                duration: 2.2,
                stagger: 0.4,
                ease: "power2.inOut",
              },
              0.8,
            )
            .to("[data-later]", { opacity: 0, duration: 0.5, stagger: 0.1 });
        } else {
          timeline
            .fromTo(
              "[data-pulse]",
              { scaleX: 0.8, opacity: 0 },
              {
                scaleX: 1,
                opacity: 0.24,
                duration: 0.35,
                ease: "power2.out",
              },
            )
            .to("[data-pulse]", { opacity: 0, duration: 0.8, ease: "sine.out" })
            .to({}, { duration: 0.9 });
        }
        let visible = false;
        const sync = () =>
          visible && !document.hidden ? timeline.play() : timeline.pause();
        const observer = new IntersectionObserver(([entry]) => {
          visible = entry.isIntersecting;
          sync();
        });
        observer.observe(root);
        document.addEventListener("visibilitychange", sync);
        return () => {
          observer.disconnect();
          document.removeEventListener("visibilitychange", sync);
        };
      });
      return () => media.revert();
    },
    { scope, dependencies: [meaning], revertOnUpdate: true },
  );
  return (
    <div
      ref={scope}
      data-slider-motion={meaning}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden rounded-full"
    >
      {meaning === "priority" &&
        [12, 25, 40, 54, 68, 82].map((left, index) => (
          <span
            key={left}
            data-bubble
            className="absolute size-1 rounded-full bg-white opacity-0"
            style={{ left: `${left}%`, top: `${35 + (index % 3) * 14}%` }}
          />
        ))}
      {meaning === "hold" && (
        <span
          data-beam
          className="absolute inset-y-0 left-0 w-1/5 rounded-full bg-linear-to-r from-transparent via-white/50 to-transparent opacity-0"
        />
      )}
      {meaning === "later" &&
        [0, 1, 2].map((index) => (
          <span key={index} data-later className="absolute inset-0 opacity-0">
            <span className="absolute top-1/2 left-0 h-1 w-3 -translate-y-1/2 rounded-full bg-white" />
          </span>
        ))}
      {meaning === "heartbeat" && (
        <span
          data-pulse
          className="absolute inset-0 origin-left rounded-full bg-white opacity-0"
        />
      )}
    </div>
  );
}
