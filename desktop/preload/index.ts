import { contextBridge, ipcRenderer } from 'electron';
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  SEND_CHANNELS,
  type EventChannel,
  type InvokeChannel,
  type SendChannel,
  type SnapflowDesktopApi,
} from '../shared/ipc';

const invokeAllowed = new Set<string>(INVOKE_CHANNELS);
const sendAllowed = new Set<string>(SEND_CHANNELS);
const eventAllowed = new Set<string>(EVENT_CHANNELS);

const api: SnapflowDesktopApi = {
  invoke: <T>(channel: InvokeChannel, payload?: unknown) => {
    if (!invokeAllowed.has(channel)) return Promise.reject(new Error(`Blocked IPC channel: ${channel}`));
    return ipcRenderer.invoke(channel, payload) as Promise<T>;
  },
  send: (channel: SendChannel, payload?: unknown) => {
    if (sendAllowed.has(channel)) ipcRenderer.send(channel, payload);
  },
  on: (channel: EventChannel, listener: (payload: unknown) => void) => {
    if (!eventAllowed.has(channel)) return () => undefined;
    const handler = (_e: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
};

contextBridge.exposeInMainWorld('snapflowDesktop', api);
