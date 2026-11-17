import { classifyChromeError, SnapflowError } from '@/shared/errors';
import type { AgentCommand } from '@/shared/messages';

/** Inject (or re-inject) the content agent into the top frame of a tab. */
export async function injectAgent(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (err) {
    const c = classifyChromeError(err);
    // Injection failing on an otherwise ordinary page is almost always the PDF viewer or a protected frame.
    if (c.code === 'UNKNOWN') {
      throw new SnapflowError(
        'RESTRICTED_PAGE',
        'SnapFlow cannot run on this page (for example Chrome\'s PDF viewer or another protected page). Only "Visible area" capture works here.',
        { cause: err },
      );
    }
    throw new SnapflowError(c.code, c.message, { cause: err });
  }
}

interface AgentReply<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/** Send a command to the content agent and unwrap its reply (throwing on failure). */
export async function agentCall<T = unknown>(tabId: number, cmd: AgentCommand): Promise<T> {
  let reply: AgentReply<T> | undefined;
  try {
    reply = (await chrome.tabs.sendMessage(tabId, cmd)) as AgentReply<T> | undefined;
  } catch (err) {
    const c = classifyChromeError(err);
    throw new SnapflowError(c.code, c.message, { cause: err });
  }
  if (!reply) throw new SnapflowError('AGENT_UNAVAILABLE', 'The page did not respond. Reload it and try again.');
  if (!reply.ok) {
    throw new SnapflowError((reply.error?.code as SnapflowError['code']) ?? 'UNKNOWN', reply.error?.message ?? 'The page reported an error.');
  }
  return reply.data as T;
}

/** Like agentCall but never throws – for best-effort cleanup. */
export async function agentTry(tabId: number, cmd: AgentCommand): Promise<boolean> {
  try {
    await agentCall(tabId, cmd);
    return true;
  } catch {
    return false;
  }
}
