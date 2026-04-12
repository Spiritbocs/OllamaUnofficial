import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';

type BrowserMessage =
  | { type: 'fetchPage'; url: string }
  | { type: 'sendToChat'; text: string; url: string; elementTag?: string }
  | { type: 'navigate'; url: string };

export class BrowserPanel {
  private static instance: BrowserPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private chatPostMessage: ((msg: unknown) => void) | undefined;

  private constructor(
    context: vscode.ExtensionContext,
    chatPostMessage: (msg: unknown) => void
  ) {
    this.chatPostMessage = chatPostMessage;

    this.panel = vscode.window.createWebviewPanel(
      'ollamaUnofficial.browser',
      '🌐 OllamaUnofficial Browser',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      }
    );

    this.panel.webview.html = BrowserPanel.getHtml();

    this.panel.webview.onDidReceiveMessage(
      async (msg: BrowserMessage) => {
        if (msg.type === 'fetchPage') {
          await this.loadPage(msg.url);
        } else if (msg.type === 'sendToChat') {
          if (this.chatPostMessage) {
            this.chatPostMessage({
              type: 'browserSelection',
              text: msg.text,
              url: msg.url,
              elementTag: msg.elementTag,
            });
          }
          // Focus the chat sidebar
          void vscode.commands.executeCommand('ollamaCoderChat.sidebar.focus');
        }
      },
      undefined,
      context.subscriptions
    );

    this.panel.onDidDispose(() => {
      BrowserPanel.instance = undefined;
    });
  }

  public static createOrShow(
    context: vscode.ExtensionContext,
    chatPostMessage: (msg: unknown) => void
  ): void {
    if (BrowserPanel.instance) {
      BrowserPanel.instance.chatPostMessage = chatPostMessage;
      BrowserPanel.instance.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    BrowserPanel.instance = new BrowserPanel(context, chatPostMessage);
  }

  private async loadPage(url: string): Promise<void> {
    try {
      const resolved = url.startsWith('http') ? url : `https://${url}`;
      const html = await BrowserPanel.fetchUrl(resolved);
      void this.panel.webview.postMessage({ type: 'pageLoaded', html, url: resolved });
    } catch (err) {
      void this.panel.webview.postMessage({
        type: 'pageError',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private static fetchUrl(url: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const lib = url.startsWith('https') ? https : http;
      const req = lib.get(
        url,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          timeout: 15000,
        },
        (res) => {
          // Follow redirects
          if (
            (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) &&
            res.headers.location
          ) {
            resolve(BrowserPanel.fetchUrl(res.headers.location));
            return;
          }
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
          res.on('error', reject);
        }
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timed out after 15s'));
      });
    });
  }

  private static getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OllamaUnofficial Browser</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 13px;
  background: var(--vscode-editor-background, #1e1e1e);
  color: var(--vscode-foreground, #cccccc);
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
#toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  background: var(--vscode-sideBar-background, #252526);
  border-bottom: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.3));
}
#urlInput {
  flex: 1;
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid var(--vscode-input-border, rgba(127,127,127,0.35));
  background: var(--vscode-input-background, #3c3c3c);
  color: var(--vscode-input-foreground, #cccccc);
  font-size: 12px;
  outline: none;
}
#urlInput:focus { border-color: var(--vscode-focusBorder, #007fd4); }
.nav-btn {
  height: 28px;
  padding: 0 12px;
  border-radius: 6px;
  border: 1px solid var(--vscode-button-border, transparent);
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
}
.nav-btn:hover { opacity: 0.88; }
.nav-btn.secondary {
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #cccccc);
}
#statusBar {
  flex: 0 0 auto;
  padding: 3px 10px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #888);
  background: var(--vscode-sideBar-background, #252526);
  border-bottom: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.2));
  min-height: 22px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#selectionBar {
  flex: 0 0 auto;
  display: none;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: color-mix(in srgb, var(--vscode-button-background, #0e639c) 15%, var(--vscode-editor-background, #1e1e1e));
  border-bottom: 1px solid color-mix(in srgb, var(--vscode-button-background, #0e639c) 40%, transparent);
  font-size: 12px;
}
#selectionBar.visible { display: flex; }
#selectionPreview {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--vscode-foreground, #ccc);
  font-style: italic;
  opacity: 0.85;
}
#sendToChat {
  flex: 0 0 auto;
  height: 26px;
  padding: 0 14px;
  border-radius: 5px;
  border: none;
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}
#sendToChat:hover { opacity: 0.88; }
#clearSel {
  background: none;
  border: none;
  color: var(--vscode-descriptionForeground, #888);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 0 2px;
}
#content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 14px 18px;
  line-height: 1.6;
}
#loader {
  display: none;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  flex: 1;
  color: var(--vscode-descriptionForeground, #888);
}
#loader.visible { display: flex; }
.loader-ring {
  width: 32px; height: 32px;
  border: 3px solid rgba(127,127,127,0.2);
  border-top-color: var(--vscode-button-background, #0e639c);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
#welcome {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  height: 100%;
  color: var(--vscode-descriptionForeground, #888);
  text-align: center;
}
#welcome h2 { font-size: 16px; color: var(--vscode-foreground, #ccc); margin-bottom: 4px; }
#welcome p { font-size: 12px; max-width: 320px; line-height: 1.6; }
.quick-links { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-top: 10px; }
.quick-link {
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--vscode-widget-border, rgba(127,127,127,0.3));
  background: none;
  color: var(--vscode-textLink-foreground, #3794ff);
  cursor: pointer;
  font-size: 11px;
}
.quick-link:hover { background: var(--vscode-toolbar-hoverBackground); }
/* Rendered page content */
#pageRoot { max-width: 860px; }
#pageRoot .oui-highlight {
  background: color-mix(in srgb, var(--vscode-button-background, #0e639c) 30%, transparent) !important;
  outline: 1px solid var(--vscode-button-background, #0e639c) !important;
  border-radius: 2px !important;
  cursor: pointer !important;
}
#pageRoot * { max-width: 100%; word-break: break-word; }
#pageRoot a { color: var(--vscode-textLink-foreground, #3794ff); }
#pageRoot h1, #pageRoot h2, #pageRoot h3, #pageRoot h4 {
  margin: 0.8em 0 0.4em;
  font-weight: 600;
  line-height: 1.3;
}
#pageRoot h1 { font-size: 1.6em; }
#pageRoot h2 { font-size: 1.3em; }
#pageRoot h3 { font-size: 1.1em; }
#pageRoot p { margin: 0 0 0.7em; }
#pageRoot ul, #pageRoot ol { margin: 0 0 0.7em 1.4em; }
#pageRoot li { margin: 0.2em 0; }
#pageRoot pre, #pageRoot code {
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  background: rgba(127,127,127,0.12);
  border-radius: 4px;
  padding: 2px 5px;
}
#pageRoot pre { padding: 10px 14px; overflow-x: auto; white-space: pre-wrap; }
#pageRoot pre code { background: none; padding: 0; }
#pageRoot table { border-collapse: collapse; margin-bottom: 0.7em; width: 100%; }
#pageRoot th, #pageRoot td { border: 1px solid rgba(127,127,127,0.25); padding: 5px 10px; text-align: left; }
#pageRoot th { background: rgba(127,127,127,0.1); font-weight: 600; }
#pageRoot blockquote {
  border-left: 3px solid rgba(127,127,127,0.35);
  padding-left: 12px;
  margin: 0 0 0.7em;
  color: var(--vscode-descriptionForeground);
}
#pageRoot img { max-width: 100%; height: auto; border-radius: 4px; }
#error {
  display: none;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex: 1;
  color: var(--vscode-errorForeground, #f85149);
  text-align: center;
}
#error.visible { display: flex; }
#error p { font-size: 12px; color: var(--vscode-descriptionForeground); max-width: 360px; }
</style>
</head>
<body>
<div id="toolbar">
  <button class="nav-btn secondary" id="backBtn" title="Back">◀</button>
  <input id="urlInput" type="text" placeholder="Enter a URL, e.g. https://example.com" spellcheck="false"/>
  <button class="nav-btn" id="goBtn">Go</button>
</div>
<div id="statusBar">Enter a URL above and press Go</div>
<div id="selectionBar">
  <span>Selected:</span>
  <span id="selectionPreview"></span>
  <button id="sendToChat">Send to Chat →</button>
  <button id="clearSel" title="Clear selection">×</button>
</div>
<div id="loader"><div class="loader-ring"></div><span>Loading page…</span></div>
<div id="error"><b>Could not load page</b><p id="errorMsg"></p></div>
<div id="content">
  <div id="welcome">
    <h2>🌐 Browse & Select</h2>
    <p>Navigate to any webpage, then select text or click on elements to send them to OllamaUnofficial chat.</p>
    <div class="quick-links">
      <button class="quick-link" data-url="https://docs.python.org/3/">Python Docs</button>
      <button class="quick-link" data-url="https://developer.mozilla.org/en-US/docs/Web/JavaScript">MDN JS</button>
      <button class="quick-link" data-url="https://github.com">GitHub</button>
      <button class="quick-link" data-url="https://stackoverflow.com">Stack Overflow</button>
      <button class="quick-link" data-url="https://news.ycombinator.com">Hacker News</button>
    </div>
  </div>
  <div id="pageRoot" style="display:none"></div>
</div>

<script>
(function() {
  const vscode = acquireVsCodeApi();
  const urlInput = document.getElementById('urlInput');
  const goBtn = document.getElementById('goBtn');
  const backBtn = document.getElementById('backBtn');
  const statusBar = document.getElementById('statusBar');
  const selectionBar = document.getElementById('selectionBar');
  const selectionPreview = document.getElementById('selectionPreview');
  const sendToChat = document.getElementById('sendToChat');
  const clearSel = document.getElementById('clearSel');
  const content = document.getElementById('content');
  const loader = document.getElementById('loader');
  const errorEl = document.getElementById('error');
  const errorMsg = document.getElementById('errorMsg');
  const welcome = document.getElementById('welcome');
  const pageRoot = document.getElementById('pageRoot');

  let currentUrl = '';
  let history = [];
  let selectedText = '';
  let selectedTag = '';

  function setLoading(on) {
    loader.classList.toggle('visible', on);
    content.style.display = on ? 'none' : '';
    errorEl.classList.remove('visible');
  }

  function showError(msg) {
    loader.classList.remove('visible');
    content.style.display = '';
    welcome.style.display = 'none';
    pageRoot.style.display = 'none';
    errorEl.classList.add('visible');
    document.getElementById('errorMsg').textContent = msg;
  }

  function navigate(url) {
    if (!url) return;
    const resolved = url.startsWith('http') ? url : 'https://' + url;
    urlInput.value = resolved;
    statusBar.textContent = 'Loading ' + resolved + '…';
    setLoading(true);
    clearSelection();
    vscode.postMessage({ type: 'fetchPage', url: resolved });
  }

  function clearSelection() {
    selectedText = '';
    selectedTag = '';
    selectionBar.classList.remove('visible');
    selectionPreview.textContent = '';
    document.querySelectorAll('.oui-highlight').forEach(el => el.classList.remove('oui-highlight'));
    window.getSelection()?.removeAllRanges();
  }

  function showSelection(text, tag) {
    if (!text || text.length < 2) return;
    selectedText = text.trim();
    selectedTag = tag || '';
    const preview = selectedText.length > 120 ? selectedText.slice(0, 120) + '…' : selectedText;
    selectionPreview.textContent = '"' + preview + '"';
    selectionBar.classList.add('visible');
  }

  // Go button
  goBtn.addEventListener('click', () => navigate(urlInput.value.trim()));
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') navigate(urlInput.value.trim());
  });
  backBtn.addEventListener('click', () => {
    if (history.length > 1) {
      history.pop();
      navigate(history.pop());
    }
  });

  // Quick links
  document.querySelectorAll('.quick-link').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.url));
  });

  // Text selection
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? '';
    if (text.length > 1 && pageRoot.contains(sel?.anchorNode)) {
      showSelection(text, '');
    } else if (!text) {
      // Don't clear if we had a click-selected element
    }
  });

  // Element click picking (Ctrl+Click or just click on elements)
  pageRoot.addEventListener('click', (e) => {
    const target = e.target;
    if (!target || target === pageRoot) return;

    // Intercept link clicks
    if (target.tagName === 'A' || target.closest('a')) {
      e.preventDefault();
      const a = target.tagName === 'A' ? target : target.closest('a');
      const href = a.getAttribute('href');
      if (href && !href.startsWith('#') && !href.startsWith('javascript')) {
        let resolved = href;
        if (href.startsWith('/') && currentUrl) {
          try {
            const u = new URL(currentUrl);
            resolved = u.origin + href;
          } catch {}
        } else if (!href.startsWith('http')) {
          try {
            resolved = new URL(href, currentUrl).href;
          } catch {}
        }
        navigate(resolved);
        return;
      }
    }

    // Alt+Click to select element
    if (e.altKey) {
      e.preventDefault();
      document.querySelectorAll('.oui-highlight').forEach(el => el.classList.remove('oui-highlight'));
      target.classList.add('oui-highlight');
      const text = target.innerText || target.textContent || '';
      showSelection(text, target.tagName.toLowerCase());
    }
  });

  // Hover highlight hint for alt+click
  pageRoot.addEventListener('mouseover', (e) => {
    if (!e.altKey) return;
    const target = e.target;
    if (target && target !== pageRoot) {
      document.querySelectorAll('.oui-hover').forEach(el => el.classList.remove('oui-hover'));
      target.style.outline = '1px dashed rgba(127,127,127,0.5)';
      target.addEventListener('mouseleave', () => { target.style.outline = ''; }, { once: true });
    }
  });

  // Send to chat
  sendToChat.addEventListener('click', () => {
    if (selectedText) {
      vscode.postMessage({ type: 'sendToChat', text: selectedText, url: currentUrl, elementTag: selectedTag });
      statusBar.textContent = '✓ Sent to chat! Selection: "' + (selectedText.length > 60 ? selectedText.slice(0,60)+'…' : selectedText) + '"';
      clearSelection();
    }
  });
  clearSel.addEventListener('click', clearSelection);

  // Receive messages from extension
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'pageLoaded') {
      currentUrl = msg.url;
      history.push(msg.url);
      urlInput.value = msg.url;
      statusBar.textContent = '✓ Loaded: ' + msg.url + '  |  Alt+Click to pick an element, or select text';

      // Parse and render the HTML
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(msg.html, 'text/html');

        // Remove scripts, style links, noscript, etc.
        doc.querySelectorAll('script, noscript, iframe, object, embed, form input[type=hidden]').forEach(el => el.remove());

        // Try to get main content area
        const main = doc.querySelector('main, article, [role=main], #main, #content, .content, .main') || doc.body;

        // Remove nav, footer, aside if we found main content
        if (main !== doc.body) {
          doc.querySelectorAll('nav, footer, aside, .nav, .footer, .sidebar, header').forEach(el => el.remove());
        }

        pageRoot.innerHTML = (main || doc.body).innerHTML;

        // Remove all event handlers from parsed content (security)
        pageRoot.querySelectorAll('*').forEach(el => {
          // Remove on* attributes
          Array.from(el.attributes).forEach(attr => {
            if (attr.name.startsWith('on')) el.removeAttribute(attr.name);
          });
        });

        // Fix relative image srcs (just remove broken images)
        pageRoot.querySelectorAll('img').forEach(img => {
          const src = img.getAttribute('src') || '';
          if (!src.startsWith('http') && !src.startsWith('data:')) {
            try {
              img.src = new URL(src, currentUrl).href;
            } catch {
              img.remove();
            }
          }
        });

      } catch (err) {
        pageRoot.textContent = 'Could not render page content.';
      }

      setLoading(false);
      welcome.style.display = 'none';
      pageRoot.style.display = '';
      errorEl.classList.remove('visible');

    } else if (msg.type === 'pageError') {
      showError(msg.error + '\\n\\nNote: Some sites block automated access. Try a different URL or check your connection.');
    }
  });
})();
</script>
</body>
</html>`;
  }
}
