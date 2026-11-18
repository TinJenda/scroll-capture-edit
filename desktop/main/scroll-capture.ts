/**
 * The scroll-and-stitch loop for native windows. It knows nothing about Electron: the caller supplies how to
 * grab the region, how to roll the wheel and how to wait, which keeps the logic testable with a fake page.
 *
 *   calibrate (one notch → how many pixels?) → scroll ~60% of the region per step → settle → measure the
 *   real shift from the pixels → stitch → stop at the bottom / on request / when alignment is lost.
 */
import { VerticalStitcher, type PixelFrame } from '@/shared/overlap';

export interface ScrollRunDeps {
  /** Current pixels of the capture region. */
  grab(): Promise<PixelFrame>;
  /** Roll the mouse wheel down by this many notches. */
  wheel(notches: number): void;
  sleep(ms: number): Promise<void>;
  shouldStop(): boolean;
  progress(p: { frames: number; height: number; note: string }): void;
  /** Cap on the stitched image height in pixels. */
  maxRows: number;
  /** Delay between a wheel burst and the first look at the result. */
  settleDelayMs?: number;
  /** Give up waiting for the content to stop moving after this long. */
  settleTimeoutMs?: number;
  maxFrames?: number;
  /** Diagnostics (enabled with SNAPFLOW_DEBUG=1). */
  log?(message: string): void;
}

export type ScrollEnd =
  /** Reached the end of the content. */
  | 'bottom'
  /** The user pressed Stop / Esc. */
  | 'stopped'
  /** Nothing scrolled at all – wrong spot, or the content does not scroll. */
  | 'nothing'
  /** Alignment could not be established; what was captured so far is kept. */
  | 'lost'
  /** Hit the output size cap. */
  | 'full'
  | 'frames';

export interface ScrollRunResult {
  image: PixelFrame;
  frames: number;
  end: ScrollEnd;
}

/** True when two frames differ in at most `tolerance` of their pixels. */
export function nearlyEqual(a: PixelFrame, b: PixelFrame, tolerance = 0.002): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  const limit = Math.floor(a.px.length * tolerance);
  let diff = 0;
  for (let i = 0; i < a.px.length; i++) {
    if (a.px[i] !== b.px[i] && ++diff > limit) return false;
  }
  return true;
}

/** Equal grabs in a row that mean "the animation is over". */
const STABLE_GRABS = 3;
const GRAB_GAP_MS = 50;
/** Without any visible change for this long, the content is considered not to be moving. */
const NO_CHANGE_MS = 700;

export async function runScrollCapture(deps: ScrollRunDeps): Promise<ScrollRunResult> {
  const settleDelay = deps.settleDelayMs ?? 80;
  const settleTimeout = deps.settleTimeoutMs ?? 3000;
  const maxFrames = deps.maxFrames ?? 400;

  /**
   * Wait for the result of a wheel burst. Smooth scrolling animates for a few hundred ms and the screen
   * grabber may hand back the same frame twice, so "two equal frames" is not enough: the content must have
   * visibly *changed* from `reference` and then stayed put for several grabs. If nothing changes for a
   * while the content simply is not moving (end of the page).
   */
  const settle = async (reference: PixelFrame): Promise<PixelFrame> => {
    await deps.sleep(settleDelay);
    let last = await deps.grab();
    let waited = settleDelay;
    let changed = !nearlyEqual(last, reference, 0);
    let stable = 0;
    while (waited < settleTimeout) {
      if (changed && stable >= STABLE_GRABS) return last;
      if (!changed && waited >= NO_CHANGE_MS) return last;
      await deps.sleep(GRAB_GAP_MS);
      waited += GRAB_GAP_MS;
      const f = await deps.grab();
      if (nearlyEqual(f, last, 0)) stable++;
      else {
        changed = true;
        stable = 0;
      }
      last = f;
    }
    return last;
  };

  const first = await deps.grab();
  const stitcher = new VerticalStitcher(first, deps.maxRows);
  let frames = 1;
  const report = (note: string) => deps.progress({ frames, height: stitcher.height, note });
  const done = (end: ScrollEnd): ScrollRunResult => ({ image: stitcher.finish(), frames, end });
  report('Calibrating…');

  /* ---- calibrate: how far does one wheel notch move the content? ---- */
  if (deps.shouldStop()) return done('stopped');
  deps.wheel(1);
  let cur = await settle(first);
  let r = stitcher.add(cur);
  deps.log?.(`calibrate: ${JSON.stringify(r)}`);
  if (r.kind === 'same') {
    await deps.sleep(450);
    cur = await settle(first);
    r = stitcher.add(cur);
  }
  if (r.kind === 'same') return done('nothing');
  if (r.kind === 'lost') return done('lost');
  if (r.kind === 'full') return done('full');
  frames++;
  let last = cur; // newest frame that is part of the stitch
  let perNotch = Math.max(1, r.shift);
  const frameH = first.height;
  // Sticky bars do not scroll, so only the rest of the frame counts as "page" when sizing a step.
  const viewport = Math.max(frameH * 0.5, frameH - r.top - r.bottom);
  /** Upper bound for a step; lowered whenever a big step could not be lined up. */
  let maxNotches = 80;
  const notchesPerStep = (): number => Math.max(1, Math.min(maxNotches, Math.floor((0.55 * viewport) / perNotch)));
  report('Scrolling…');

  /* ---- main loop ---- */
  let sameInARow = 0;
  while (frames < maxFrames) {
    if (deps.shouldStop()) return done('stopped');
    const n = notchesPerStep();
    deps.wheel(n);
    cur = await settle(last);
    if (deps.shouldStop()) {
      // Take whatever the last burst produced, then stop.
      const late = stitcher.add(cur, { expected: perNotch * n });
      if (late.kind === 'added') frames++;
      return done('stopped');
    }

    r = stitcher.add(cur, { expected: perNotch * n });
    deps.log?.(`step n=${n} perNotch=${perNotch.toFixed(1)} -> ${JSON.stringify(r)}`);
    if (r.kind === 'lost') {
      // Often a transition still in flight: look again before giving up.
      await deps.sleep(400);
      cur = await settle(last);
      r = stitcher.add(cur, { expected: perNotch * n });
    }
    // Too little to anchor on in the overlap of two far-apart frames (sparse or flat content): scroll part of the
    // way back so the frames overlap more, and keep the smaller step from now on.
    let tried = n;
    while (r.kind === 'lost' && tried > 1 && !deps.shouldStop()) {
      const smaller = Math.max(1, Math.floor(tried / 2));
      deps.wheel(-(tried - smaller));
      tried = smaller;
      maxNotches = Math.min(maxNotches, smaller);
      cur = await settle(cur);
      r = stitcher.add(cur, { expected: perNotch * tried });
      deps.log?.(`  back-off to ${tried} notches -> ${JSON.stringify(r)}`);
    }
    if (r.kind === 'added') {
      frames++;
      last = cur;
      sameInARow = 0;
      if (r.shift >= tried * perNotch * 0.7 && r.shift <= tried * perNotch * 1.3) perNotch = 0.5 * perNotch + 0.5 * (r.shift / tried);
      report('Scrolling… (Esc to stop)');
    } else if (r.kind === 'same') {
      if (++sameInARow >= 2) return done('bottom');
      await deps.sleep(450); // lazy content may still be arriving – look once more
    } else if (r.kind === 'full') {
      return done('full');
    } else {
      return done('lost');
    }
  }
  return done('frames');
}
