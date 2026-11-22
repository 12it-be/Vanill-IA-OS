/**
 * ==============================================================================
 * Vanill-IA OS — Isolated Remote Web Browser (`web-browser.js`)
 * Remote Browser Isolation (TigerVNC + Openbox + Chromium + noVNC, 0 MB at rest)
 * - Starts isolated session on window open -> mounts `/browser/vnc.html` iframe
 *   with `autoconnect=true&resize=remote` for dynamic X11 resolution scaling
 * - Injects "Reset Session" button directly into the window titlebar
 * - Automatically triggers `browser_stop` on window close / unload (zero trace)
 * ==============================================================================
 */

import { t } from '../i18n.js';

const INSTALL_BROWSER_DEPS_CMD = 'sudo apt update && sudo apt install -y tigervnc-standalone-server novnc websockify openbox && (sudo apt install -y chromium || sudo apt install -y chromium-browser)';
const NOVNC_IFRAME_URL = '/browser/vnc.html?autoconnect=true&resize=remote&path=browser/websockify';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function mountApp({ container, api, windowRecord, params }) {
  let closed = false;
  let sessionStarted = false;
  let currentMode = 'loading'; // loading | active | missing_deps | offline | error
  let lastErrorMsg = '';
  let initialUrl = typeof params?.url === 'string' ? params.url : '';

  container.style.overflow = 'hidden';
  const notify = (msg, type = 'info') => window.__VANILLIA_DESKTOP__?.toast(msg, type);

  // Inject "Reset Session" button into the window titlebar
  let resetBtn = null;
  if (windowRecord?.extraActionsEl) {
    resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'btn-xs';
    resetBtn.style.marginRight = '4px';
    resetBtn.style.padding = '3px 9px';
    resetBtn.style.fontSize = '0.73rem';
    resetBtn.innerHTML = `↻ <span data-i18n="browser.reset_session">${escapeHtml(t('browser.reset_session'))}</span>`;
    resetBtn.title = t('browser.reset_session_title');
    windowRecord.extraActionsEl.appendChild(resetBtn);

    resetBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (resetBtn.disabled) return;
      await resetSession();
    });
  }

  function renderLoading(messageKey = 'browser.starting_desc') {
    currentMode = 'loading';
    container.innerHTML = `
      <div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px;text-align:center;background:#0B0E14;">
        <div style="width:46px;height:46px;border-radius:50%;border:3px solid rgba(255,109,90,0.2);border-top-color:var(--os-accent);animation:vBrowserSpin 0.85s linear infinite;margin-bottom:16px;"></div>
        <style>@keyframes vBrowserSpin { to { transform: rotate(360deg); } }</style>
        <h3 style="margin-bottom:6px;">🌐 ${escapeHtml(t('browser.starting_title'))}</h3>
        <p style="font-size:0.84rem;color:var(--os-text-secondary);max-width:420px;">${escapeHtml(t(messageKey))}</p>
      </div>
    `;
  }

  function renderMissingDeps(details) {
    currentMode = 'missing_deps';
    container.innerHTML = `
      <div class="module-content" style="justify-content:center;align-items:center;">
        <div class="settings-card" style="max-width:600px;width:100%;border-color:rgba(245,158,11,0.5);">
          <h3 style="color:var(--os-warning);">⚠️ ${escapeHtml(t('browser.missing_deps_title'))}</h3>
          <p class="desc">${escapeHtml(t('browser.missing_deps_desc'))}</p>
          ${details ? `<p style="font-family:var(--font-mono);font-size:0.76rem;color:var(--os-text-secondary);margin-bottom:10px;">${escapeHtml(details)}</p>` : ''}
          <code class="selectable" style="display:block;padding:10px 12px;border-radius:10px;background:#090B10;border:1px solid var(--os-border-strong);font-family:var(--font-mono);font-size:0.79rem;color:#F8FAFC;margin-bottom:12px;">${INSTALL_BROWSER_DEPS_CMD}</code>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button type="button" class="btn-xs" id="copyBrowserDepsBtn">📋 ${escapeHtml(t('common.copy'))}</button>
            <button type="button" class="btn-xs primary" id="runTermBrowserDepsBtn">▶_ ${escapeHtml(t('mount.run_in_terminal'))}</button>
            <button type="button" class="btn-xs" id="retryBrowserStartBtn">↻ ${escapeHtml(t('common.refresh'))}</button>
          </div>
        </div>
      </div>
    `;

    container.querySelector('#copyBrowserDepsBtn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      await navigator.clipboard.writeText(INSTALL_BROWSER_DEPS_CMD);
      btn.textContent = `✓ ${t('common.copied')}`;
    });

    container.querySelector('#runTermBrowserDepsBtn')?.addEventListener('click', () => {
      window.__VANILLIA_DESKTOP__?.launchAppById('terminal', {
        runCommand: INSTALL_BROWSER_DEPS_CMD,
      });
    });

    container.querySelector('#retryBrowserStartBtn')?.addEventListener('click', () => bootSession());
  }

  function renderOfflineOrError(msg, isOffline = false) {
    currentMode = isOffline ? 'offline' : 'error';
    lastErrorMsg = msg;
    container.innerHTML = `
      <div class="module-content" style="justify-content:center;align-items:center;">
        <div class="settings-card" style="max-width:520px;width:100%;text-align:center;">
          <h3>🌐 ${escapeHtml(t(isOffline ? 'browser.offline_title' : 'browser.error_title'))}</h3>
          <p class="desc" style="margin-top:6px;">${escapeHtml(msg)}</p>
          <button type="button" class="os-btn os-btn-primary" id="retryBrowserBtn" style="width:auto;margin-top:8px;">↻ ${escapeHtml(t('common.refresh'))}</button>
        </div>
      </div>
    `;
    container.querySelector('#retryBrowserBtn')?.addEventListener('click', () => bootSession());
  }

  function mountNoVncIframe() {
    currentMode = 'active';
    const cacheBust = Date.now();
    container.innerHTML = `
      <iframe
        id="rbiNoVncFrame"
        src="${NOVNC_IFRAME_URL}&_t=${cacheBust}"
        style="width:100%;height:100%;border:none;display:block;background:#0F1115;"
        allow="clipboard-read; clipboard-write; fullscreen"
      ></iframe>
    `;
  }

  async function bootSession() {
    if (closed) return;
    renderLoading('browser.starting_desc');
    if (resetBtn) resetBtn.disabled = true;

    try {
      const status = await api.get('/api/browser.php?action=status');
      if (!status.agent_online) {
        renderOfflineOrError(t('browser.offline_desc'), true);
        return;
      }
      if (Array.isArray(status.missing_list) && status.missing_list.length > 0) {
        renderMissingDeps(status.missing_packages);
        return;
      }

      await api.post('/api/browser.php?action=start', initialUrl ? { url: initialUrl } : {});
      initialUrl = '';
      if (closed) {
        api.post('/api/browser.php?action=stop').catch(() => {});
        return;
      }
      sessionStarted = true;
      mountNoVncIframe();
    } catch (err) {
      if (err.code === 'BROWSER_DEPS_MISSING') {
        renderMissingDeps(err.message);
      } else {
        renderOfflineOrError(err.message, false);
      }
    } finally {
      if (resetBtn) resetBtn.disabled = false;
    }
  }

  async function resetSession() {
    if (closed) return;
    if (resetBtn) resetBtn.disabled = true;
    renderLoading('browser.resetting_desc');

    try {
      await api.post('/api/browser.php?action=reset');
      sessionStarted = true;
      mountNoVncIframe();
      notify(t('browser.reset_done_toast'));
    } catch (err) {
      notify(err.message, 'error');
      renderOfflineOrError(err.message, false);
    } finally {
      if (resetBtn) resetBtn.disabled = false;
    }
  }

  // Ensure ephemeral session stops even if the user closes/reloads the entire browser tab
  const onPageHide = () => {
    if (sessionStarted && navigator.sendBeacon) {
      const payload = new Blob([JSON.stringify({ _csrf: api.csrfToken })], { type: 'application/json' });
      navigator.sendBeacon('/api/browser.php?action=stop', payload);
    }
  };
  window.addEventListener('pagehide', onPageHide);

  const onLangChanged = () => {
    if (resetBtn) {
      resetBtn.innerHTML = `↻ <span data-i18n="browser.reset_session">${escapeHtml(t('browser.reset_session'))}</span>`;
      resetBtn.title = t('browser.reset_session_title');
    }
    if (currentMode === 'offline') {
      renderOfflineOrError(t('browser.offline_desc'), true);
    } else if (currentMode === 'error') {
      renderOfflineOrError(lastErrorMsg, false);
    }
  };
  window.addEventListener('vanillia:lang-changed', onLangChanged);

  await bootSession();

  return {
    onLaunch(newParams) {
      if (newParams?.url && typeof newParams.url === 'string') {
        api.post('/api/browser.php?action=start', { url: newParams.url }).catch(() => {});
      }
    },
    cleanup() {
      closed = true;
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('vanillia:lang-changed', onLangChanged);
      if (resetBtn) {
        resetBtn.remove();
      }
      if (sessionStarted) {
        sessionStarted = false;
        api.post('/api/browser.php?action=stop').catch(() => {});
      }
    },
  };
}
