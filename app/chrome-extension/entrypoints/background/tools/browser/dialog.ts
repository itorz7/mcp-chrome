import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

type DialogAction = 'accept' | 'dismiss' | 'arm' | 'disarm';

interface HandleDialogParams {
  action: DialogAction;
  promptText?: string;
  response?: 'accept' | 'dismiss';
  ttlMs?: number;
  tabId?: number;
}

interface ArmedHandler {
  tabId: number;
  response: 'accept' | 'dismiss';
  promptText?: string;
  listener: (source: chrome.debugger.Debuggee, method: string, params?: any) => void;
  expireTimer: ReturnType<typeof setTimeout>;
  firedCount: number;
}

const DEFAULT_TTL_MS = 10_000;
const MAX_TTL_MS = 120_000;
const ARM_OWNER = 'dialog-arm';

const armedByTab = new Map<number, ArmedHandler>();

async function disarmInternal(tabId: number): Promise<void> {
  const handler = armedByTab.get(tabId);
  if (!handler) return;
  chrome.debugger.onEvent.removeListener(handler.listener);
  clearTimeout(handler.expireTimer);
  armedByTab.delete(tabId);
  try {
    await cdpSessionManager.detach(tabId, ARM_OWNER);
  } catch {
    // best effort
  }
}

class HandleDialogTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.HANDLE_DIALOG;

  async execute(args: HandleDialogParams): Promise<ToolResult> {
    const { action } = args || ({} as HandleDialogParams);
    if (!action || !['accept', 'dismiss', 'arm', 'disarm'].includes(action)) {
      return createErrorResponse('action must be "accept", "dismiss", "arm", or "disarm"');
    }

    try {
      const tabId = await this.resolveTabId(args.tabId);
      if (tabId == null) return createErrorResponse('No active tab found');

      if (action === 'arm') return await this.arm(tabId, args);
      if (action === 'disarm') return await this.disarm(tabId);
      return await this.handleNow(tabId, action, args.promptText);
    } catch (error) {
      return createErrorResponse(
        `Failed to handle dialog: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async resolveTabId(explicit?: number): Promise<number | null> {
    if (typeof explicit === 'number') return explicit;
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return activeTab?.id ?? null;
  }

  private async handleNow(
    tabId: number,
    action: 'accept' | 'dismiss',
    promptText?: string,
  ): Promise<ToolResult> {
    await cdpSessionManager.withSession(tabId, 'dialog', async () => {
      await cdpSessionManager.sendCommand(tabId, 'Page.enable');
      await cdpSessionManager.sendCommand(tabId, 'Page.handleJavaScriptDialog', {
        accept: action === 'accept',
        promptText: action === 'accept' ? promptText : undefined,
      });
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, action, promptText: promptText || null }),
        },
      ],
      isError: false,
    };
  }

  private async arm(tabId: number, args: HandleDialogParams): Promise<ToolResult> {
    const response = args.response ?? 'accept';
    if (response !== 'accept' && response !== 'dismiss') {
      return createErrorResponse('response must be "accept" or "dismiss" when arming');
    }
    const ttlMs = Math.min(
      MAX_TTL_MS,
      Math.max(500, typeof args.ttlMs === 'number' ? args.ttlMs : DEFAULT_TTL_MS),
    );

    // Replace any existing armed handler for this tab.
    await disarmInternal(tabId);

    await cdpSessionManager.attach(tabId, ARM_OWNER);
    await cdpSessionManager.sendCommand(tabId, 'Page.enable');

    const listener = (source: chrome.debugger.Debuggee, method: string) => {
      if (source.tabId !== tabId) return;
      if (method !== 'Page.javascriptDialogOpening') return;
      const handler = armedByTab.get(tabId);
      if (!handler) return;
      // Fire-and-forget: auto-handle without awaiting the armed caller.
      chrome.debugger
        .sendCommand({ tabId }, 'Page.handleJavaScriptDialog', {
          accept: handler.response === 'accept',
          promptText: handler.response === 'accept' ? handler.promptText : undefined,
        })
        .then(() => {
          handler.firedCount += 1;
        })
        .catch(() => {
          // Dialog may already be closed; swallow.
        });
    };

    const expireTimer = setTimeout(() => {
      void disarmInternal(tabId);
    }, ttlMs);

    const armed: ArmedHandler = {
      tabId,
      response,
      promptText: args.promptText,
      listener,
      expireTimer,
      firedCount: 0,
    };
    armedByTab.set(tabId, armed);
    chrome.debugger.onEvent.addListener(listener);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            action: 'arm',
            tabId,
            response,
            promptText: args.promptText ?? null,
            ttlMs,
          }),
        },
      ],
      isError: false,
    };
  }

  private async disarm(tabId: number): Promise<ToolResult> {
    const existed = armedByTab.has(tabId);
    const firedCount = armedByTab.get(tabId)?.firedCount ?? 0;
    await disarmInternal(tabId);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            action: 'disarm',
            tabId,
            wasArmed: existed,
            firedCount,
          }),
        },
      ],
      isError: false,
    };
  }
}

export const handleDialogTool = new HandleDialogTool();

// Clean up armed handlers when tab closes to avoid leaking listeners.
chrome.tabs.onRemoved.addListener((tabId) => {
  void disarmInternal(tabId);
});
