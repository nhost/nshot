import type {
  ActionResponse,
  CaptureResponse,
  ContentRequest,
  FreezeCommand,
  ToggleCommand,
} from './content/messages.ts';

const CONTENT_SCRIPT = 'content.js';

// The dev harness pages mount their own copy of the toolbar with the Chrome
// APIs stubbed, so the real extension must never inject there (it would stack a
// second toolbar on top). This mirrors the manifest `exclude_matches`.
const EXCLUDED_URL = /\/harness2?\.html(?:[?#]|$)/;

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Deliver a command to a tab's content script, injecting it on first use
 * (first press, or after a full page reload) then retrying. */
async function sendToTab(
  tab: chrome.tabs.Tab,
  message: ToggleCommand | FreezeCommand,
): Promise<void> {
  const tabId = tab.id;
  if (tabId === undefined || EXCLUDED_URL.test(tab.url ?? '')) {
    return;
  }
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_SCRIPT],
    });
    await chrome.tabs.sendMessage(tabId, message);
  }
}

chrome.action.onClicked.addListener((tab) => {
  void sendToTab(tab, { type: 'toggle' });
});

// Browser-global keyboard shortcuts (configurable at
// chrome://extensions/shortcuts). Handled here rather than via a page-level
// listener so they work on every tab without first opening the tool there.
const COMMAND_MESSAGE: Record<string, ToggleCommand | FreezeCommand> = {
  'toggle-tool': { type: 'toggle' },
  'freeze-ui': { type: 'freeze' },
};

chrome.commands.onCommand.addListener((command, tab) => {
  const message = COMMAND_MESSAGE[command];
  if (!message) {
    return;
  }
  if (tab) {
    void sendToTab(tab, message);
    return;
  }
  void chrome.tabs
    .query({ active: true, currentWindow: true })
    .then(([active]) => {
      if (active) {
        void sendToTab(active, message);
      }
    });
});

async function handleCapture(
  sender: chrome.runtime.MessageSender,
): Promise<CaptureResponse> {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(
      sender.tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT,
      { format: 'png' },
    );
    return { ok: true, dataUrl };
  } catch (error) {
    return { ok: false, error: errMessage(error) };
  }
}

async function handleDownload(
  dataUrl: string,
  filename: string,
  saveAs: boolean,
): Promise<ActionResponse> {
  try {
    await chrome.downloads.download({
      url: dataUrl,
      filename: filename.replace(/^\/+/, '') || 'screenshot.png',
      saveAs,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errMessage(error) };
  }
}

chrome.runtime.onMessage.addListener(
  (message: ContentRequest, sender, sendResponse) => {
    switch (message.type) {
      case 'capture':
        void handleCapture(sender).then(sendResponse);
        return true;
      case 'download':
        void handleDownload(
          message.dataUrl,
          message.filename,
          message.saveAs ?? false,
        ).then(sendResponse);
        return true;
      case 'open-shortcuts':
        // chrome:// pages can't be opened from page content, so the worker
        // opens the shortcuts page where the toggle command can be rebound.
        void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
        return false;
      default:
        return false;
    }
  },
);
