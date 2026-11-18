/** Names shared by the main process, the preload bridge and the renderer pages. */

export type DesktopMode = 'region' | 'screen' | 'window' | 'scrolling';

export const DESKTOP_MODES: readonly DesktopMode[] = ['region', 'screen', 'window', 'scrolling'];

export const isDesktopMode = (v: unknown): v is DesktopMode => typeof v === 'string' && (DESKTOP_MODES as readonly string[]).includes(v);

/** Request/response channels (renderer → main). */
export const INVOKE_CHANNELS = [
  'capture:start',
  'viewer:open-editor',
  'viewer:open-preview',
  'history:open',
  'settings:open',
  'file:save',
  'window:close',
  'app:info',
  'picker:list',
] as const;

/** Fire-and-forget messages (renderer → main). */
export const SEND_CHANNELS = [
  'overlay:done',
  'overlay:cancel',
  'pill:stop',
  'pill:discard',
  'hub:reply',
  'picker:choose',
  'picker:cancel',
] as const;

/** Messages pushed to renderers (main → renderer). */
export const EVENT_CHANNELS = ['hub:store', 'pill:update', 'launcher:update'] as const;

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];
export type SendChannel = (typeof SEND_CHANNELS)[number];
export type EventChannel = (typeof EVENT_CHANNELS)[number];

export interface SnapflowDesktopApi {
  invoke<T = unknown>(channel: InvokeChannel, payload?: unknown): Promise<T>;
  send(channel: SendChannel, payload?: unknown): void;
  on(channel: EventChannel, listener: (payload: unknown) => void): () => void;
}

export interface OverlayDone {
  mode: 'region' | 'scrolling';
  /** Selection in overlay CSS pixels. */
  rect: { x: number; y: number; width: number; height: number };
}

export interface PillUpdate {
  frames: number;
  height: number;
  note: string;
}

export interface PickerWindow {
  /** desktopCapturer source id, e.g. `window:123456:0`. */
  id: string;
  name: string;
  /** Small preview as a data URL. */
  thumbnail: string;
}

export interface LauncherState {
  hotkeys: Array<{ mode: DesktopMode; accelerator: string; registered: boolean }>;
  busy: boolean;
}

export const APP_ORIGIN = 'snapflow://app/';
