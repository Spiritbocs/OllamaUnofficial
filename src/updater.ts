/**
 * OllamaUnofficial — Self-updater
 *
 * On activation, silently checks GitHub Releases for a newer version.
 * If found, shows a notification with three options:
 *   • Install Now   — downloads the .vsix to OS temp dir and installs it in-place
 *   • View Release  — opens the release page in the browser
 *   • Later         — dismissed, won't ask again until next startup
 */

import * as vscode from 'vscode';
import * as https from 'https';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';

const RELEASES_API = 'https://api.github.com/repos/Spiritbocs/OllamaUnofficial/releases/latest';
const RELEASES_PAGE = 'https://github.com/Spiritbocs/OllamaUnofficial/releases';
const USER_AGENT = 'OllamaUnofficial-UpdateChecker/1.0';

type GithubRelease = {
  tag_name?: string;
  html_url?: string;
  assets?: Array<{
    name: string;
    browser_download_url: string;
  }>;
};

/** Compare two semver strings. Returns true if `a` is strictly newer than `b`. */
function isNewer(a: string, b: string): boolean {
  const parse = (v: string): number[] =>
    v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat > bPat;
}

/** Fetch JSON from a URL, following up to 3 redirects. */
function fetchJson(url: string, redirects = 3): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: 10000 }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location && redirects > 0) {
        resolve(fetchJson(res.headers.location, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode ?? 'unknown'}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown);
        } catch (e) {
          reject(e);
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/** Download a binary file to `destPath`, following redirects. */
function downloadFile(url: string, destPath: string, redirects = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': USER_AGENT }, timeout: 60000 },
      (res) => {
        if (
          (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) &&
          res.headers.location &&
          redirects > 0
        ) {
          resolve(downloadFile(res.headers.location, destPath, redirects - 1));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode ?? 'unknown'}`));
          return;
        }
        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', (err) => { fs.unlink(destPath, () => undefined); reject(err); });
        res.on('error', (err) => { fs.unlink(destPath, () => undefined); reject(err); });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Download timed out')); });
  });
}

/** Download the VSIX and install it via the VS Code extension host. */
async function installUpdate(
  downloadUrl: string,
  filename: string,
  log: vscode.OutputChannel
): Promise<void> {
  const tmpPath = nodePath.join(os.tmpdir(), filename);
  log.appendLine(`[updater] Downloading ${downloadUrl} → ${tmpPath}`);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Downloading OllamaUnofficial ${filename}…`,
      cancellable: false,
    },
    async () => {
      await downloadFile(downloadUrl, tmpPath);
    }
  );

  log.appendLine('[updater] Download complete. Installing…');

  try {
    await vscode.commands.executeCommand(
      'workbench.extensions.installExtension',
      vscode.Uri.file(tmpPath)
    );
  } finally {
    // Clean up temp file after a short delay
    setTimeout(() => {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }, 5000);
  }

  const reload = await vscode.window.showInformationMessage(
    '✅ OllamaUnofficial updated! Reload VS Code to apply the new version.',
    'Reload Now',
    'Later'
  );

  if (reload === 'Reload Now') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

/**
 * Main entry point — call this from `activate()`.
 * Runs silently in the background; never throws or blocks activation.
 */
export function checkForUpdates(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel
): void {
  // Delay the check by 8 seconds so it doesn't slow down startup
  log.appendLine('[updater] Update check scheduled (8s delay).');
  setTimeout(() => {
    void (async () => {
      try {
        log.appendLine('[updater] Starting update check…');
        // Get the currently installed version from the extension manifest
        const ext =
          vscode.extensions.getExtension('Spiritbocs.ollamaunofficial') ??
          vscode.extensions.getExtension('undefined_publisher.ollamaunofficial');

        const currentVersion: string =
          (ext?.packageJSON as Record<string, unknown> | undefined)?.['version'] as string ?? '0.0.0';

        log.appendLine(`[updater] Current version: ${currentVersion}`);

        const data = await fetchJson(RELEASES_API) as GithubRelease;
        const latestTag = data.tag_name ?? '';
        const latestVersion = latestTag.replace(/^v/, '');

        if (!latestVersion) {
          log.appendLine('[updater] Could not parse latest version from GitHub.');
          return;
        }

        log.appendLine(`[updater] Latest on GitHub: ${latestTag}`);

        if (!isNewer(latestVersion, currentVersion)) {
          log.appendLine('[updater] Already up to date.');
          return;
        }

        // Find the .vsix asset in the release
        const vsixAsset = data.assets?.find((a) => a.name.endsWith('.vsix'));

        log.appendLine(`[updater] Update available: v${currentVersion} → ${latestTag}`);

        const choice = await vscode.window.showInformationMessage(
          `🚀 OllamaUnofficial ${latestTag} is available! (you have v${currentVersion})`,
          'Install Now',
          'View Release',
          'Later'
        );

        if (choice === 'Install Now') {
          if (!vsixAsset) {
            void vscode.window.showWarningMessage('Could not find the .vsix file in the release. Opening the release page instead.');
            void vscode.env.openExternal(vscode.Uri.parse(data.html_url ?? RELEASES_PAGE));
            return;
          }
          await installUpdate(vsixAsset.browser_download_url, vsixAsset.name, log);
        } else if (choice === 'View Release') {
          void vscode.env.openExternal(vscode.Uri.parse(data.html_url ?? RELEASES_PAGE));
        }
        // 'Later' → do nothing
      } catch (err) {
        // Silently swallow — a failed update check should never affect normal use
        log.appendLine(`[updater] Check skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }, 8000);
}
