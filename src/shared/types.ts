export type CaptureMode = 'visible' | 'area' | 'fullPage' | 'element';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export type WarningCode =
  | 'downscaled'
  | 'truncated'
  | 'nested-scroll'
  | 'height-changed'
  | 'horizontal-overflow'
  | 'frames';

export interface CaptureWarning {
  code: WarningCode;
  message: string;
}

export interface CaptureMeta {
  mode: CaptureMode;
  tabId?: number;
  windowId?: number;
  /** origin + pathname only – query strings and hashes may contain secrets and are never stored. */
  pageUrl?: string;
  pageTitle?: string;
  /** Image pixels per CSS pixel (devicePixelRatio including browser zoom). */
  scale: number;
  viewport: Size;
  warnings: CaptureWarning[];
}

export interface EditedState {
  blob: Blob;
  width: number;
  height: number;
  updatedAt: number;
}

export interface CaptureRecord {
  id: string;
  createdAt: number;
  width: number;
  height: number;
  /** The untouched screenshot as PNG. */
  blob: Blob;
  thumb?: Blob;
  meta: CaptureMeta;
  /** Flattened annotated version, stored when the user returns from the editor. */
  edited?: EditedState;
  /** Serialized editor document (annotations + crop) so edits are never lost. */
  draft?: string;
  /** True once the user opened the editor for this capture. */
  editorOpened?: boolean;
  /** True when the capture belongs to the (opt-in) screenshot history. */
  keep: boolean;
}

export type ImageFormat = 'png' | 'jpeg' | 'webp';

export const IMAGE_MIME: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export const IMAGE_EXT: Record<ImageFormat, string> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
};
