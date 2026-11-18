/**
 * Hidden page that owns writes of new captures to IndexedDB, so they live in the same origin as the
 * preview / editor / history pages that read them. The main process hands it the PNG bytes.
 */
import '../shim';
import { makeThumbnail } from '@/core/image';
import { purgeCaptures, putCapture } from '@/shared/captures';
import { loadSettings } from '@/shared/settings';
import type { CaptureMeta, CaptureRecord } from '@/shared/types';

interface StoreRequest {
  reqId: number;
  id: string;
  png: Uint8Array;
  width: number;
  height: number;
  meta: CaptureMeta;
}

window.snapflowDesktop.on('hub:store', async (raw) => {
  const req = raw as StoreRequest;
  try {
    const settings = await loadSettings();
    const blob = new Blob([req.png as BlobPart], { type: 'image/png' });
    const record: CaptureRecord = {
      id: req.id,
      createdAt: Date.now(),
      width: req.width,
      height: req.height,
      blob,
      meta: req.meta,
      keep: settings.historyEnabled,
    };
    if (settings.historyEnabled) {
      try {
        record.thumb = await makeThumbnail(blob, req.width, req.height);
      } catch (err) {
        console.error('[snapflow] thumbnail failed', err);
      }
    }
    await putCapture(record);
    void purgeCaptures({ historyLimit: settings.historyLimit, historyMaxBytes: settings.historyMaxMB * 1024 * 1024 }).catch(() => undefined);
    window.snapflowDesktop.send('hub:reply', { reqId: req.reqId, ok: true });
  } catch (err) {
    window.snapflowDesktop.send('hub:reply', { reqId: req.reqId, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
