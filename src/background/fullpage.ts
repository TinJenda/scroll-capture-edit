import type { ScrollDirection } from '@/shared/types';
import { captureScrolling, type ScrollCaptureOptions, type ScrollCaptureResult } from './scrolling-engine';

export type FullPageOptions = Omit<ScrollCaptureOptions, 'direction'> & { direction?: ScrollDirection };
export type FullPageResult = ScrollCaptureResult;

/** Full-page capture is the scrolling engine pointed at the document, vertically. */
export function captureFullPage(opts: FullPageOptions): Promise<FullPageResult> {
  return captureScrolling({ direction: 'vertical', ...opts });
}
