/** Hard limits and timings shared by the capture pipeline. */

/** Chrome limits captureVisibleTab to 2 calls per second; stay safely below. */
export const MIN_CAPTURE_INTERVAL_MS = 600;

/** Largest canvas edge / area we are willing to allocate (Chrome's hard limit is 16384 x 16384 in many builds). */
export const MAX_CANVAS_DIMENSION = 16384;
export const MAX_CANVAS_AREA = 100_000_000;
/** Below this scale a downscaled full-page capture becomes unreadable; we truncate instead (with a warning). */
export const MIN_OUTPUT_SCALE = 0.5;

/** Safety cap on the number of viewport frames in one full-page capture. */
export const MAX_FRAMES = 120;
/** CSS px by which consecutive full-page frames overlap, so rounding can never open a seam. */
export const FRAME_OVERLAP_CSS = 2;
/** Extra attempts when the page grows while we are capturing it. */
export const MAX_GROWTH_RETRIES = 3;
/** Time we wait after a scroll for layout, lazy images and paint to settle. */
export const DEFAULT_SETTLE_MS = 140;
/** Maximum time we wait for visible lazy images to finish loading after a scroll. */
export const IMAGE_WAIT_MS = 1200;

/** Transient (non-history) captures are purged after this long. */
export const TRANSIENT_TTL_MS = 6 * 60 * 60 * 1000;

export const PREVIEW_PATH = 'preview/index.html';
export const EDITOR_PATH = 'editor/index.html';
export const HISTORY_PATH = 'history/index.html';
export const OPTIONS_PATH = 'options/index.html';

/** Tolerance (px) for rounding differences between consecutive frames. */
export const STITCH_TOLERANCE_PX = 2;
