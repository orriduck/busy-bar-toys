import gsap from "gsap";

/**
 * useGSAP reverts its context without suppressEvents. Measured list motion must
 * retain the last onUpdate sample, rather than sample the restored DOM. Own that
 * subtree explicitly, and let the parent hook call its returned cleanup.
 */
export function measuredMotionScope(parent: gsap.Context, setup: () => void) {
  let child: gsap.Context | undefined;
  parent.ignore(() => {
    child = gsap.context(setup);
  });
  return () => child?.revert({ suppressEvents: true });
}
