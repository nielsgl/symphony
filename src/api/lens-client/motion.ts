// Monotonic animation clock for the lens.
//
// The cardinal motion rule from the spec: animation phase MUST NOT reset on
// data refresh. Orbit nodes, lens rings, and the star field should keep their
// phase across snapshots. We achieve this by:
//   - Using CSS animations on persistent DOM nodes (we mutate text/attrs, not
//     the element identity).
//   - Driving any JS-controlled motion off a single performance.now()-based
//     clock that never restarts.

const startMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
const prefersReduced =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

export function uptimeMs(): number {
  return (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startMs;
}

/** Phase in [0, 1) for a given orbit period (seconds). Stable across refreshes. */
export function phase(periodSeconds: number): number {
  if (prefersReduced) return 0;
  const periodMs = Math.max(1, periodSeconds * 1000);
  return (uptimeMs() % periodMs) / periodMs;
}

export function reducedMotion(): boolean {
  return prefersReduced;
}

export type AnimationCallback = (uptimeMs: number) => void;

const callbacks = new Set<AnimationCallback>();

export function registerAnimation(cb: AnimationCallback): () => void {
  callbacks.add(cb);
  return () => callbacks.delete(cb);
}

let running = false;

export function startMotionLoop() {
  if (running) return;
  running = true;
  const tick = () => {
    if (prefersReduced) {
      // Run callbacks once so layout is positioned, then stop.
      const t = uptimeMs();
      for (const cb of callbacks) cb(t);
      return;
    }
    const t = uptimeMs();
    for (const cb of callbacks) cb(t);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Pulse a single-shot animation on the given element by toggling a CSS class. */
export function pulse(node: Element, cls = 'lens-pulse-once', durationMs = 600) {
  if (prefersReduced) return;
  node.classList.add(cls);
  setTimeout(() => node.classList.remove(cls), durationMs);
}
