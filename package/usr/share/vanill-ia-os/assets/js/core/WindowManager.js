/**
 * ==============================================================================
 * Vanill-IA OS — Multi-Window Engine (WindowManager.js)
 * - Smooth Pointer Drag & Drop with Edge Snap Preview (Left / Right / Maximize)
 * - 8-Direction Resizing + Iframe Pointer Shield for Embedded Apps/Plugins
 * - Automatic Off-Screen Window Clamping & Centering (e.g. 4K -> 1080p resize)
 * - Memorized Coordinates Persistence + "Center Window" + "Close All & Reset"
 * - Plugin `launchMode: "window"` (sandboxed iframe) & `"external"` (new tab)
 * ==============================================================================
 */

import { api } from './ApiClient.js';
import { t, resolveLocalized } from '../i18n.js';

export const Icons = {
  layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  'folder-open': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  sparkles: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/><path d="M5 3v4"/><path d="M3 5h4"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  sliders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="2" y1="14" x2="6" y2="14"/><line x1="10" y1="8" x2="14" y2="8"/><line x1="18" y1="16" x2="22" y2="16"/></svg>',
  'file-code': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><polyline points="10 13 8 15 10 17"/><polyline points="14 13 16 15 14 17"/></svg>',
  'book-open': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  harddrive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="12" x2="2" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" y1="16" x2="6.01" y2="16"/><line x1="10" y1="16" x2="10.01" y2="16"/></svg>',
  server: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>',
  minimize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  maximize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2.5"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
};

export function getAppIconSvg(name) {
  return Icons[name] || Icons.box;
}

export function renderAppVisualIcon(appDef) {
  const fallbackSvg = getAppIconSvg(appDef?.icon);
  if (appDef?.icon_url) {
    const safeUrl = String(appDef.icon_url).replace(/"/g, '&quot;');
    return `<img src="${safeUrl}" alt="" draggable="false" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex';"><span style="display:none;width:100%;height:100%;align-items:center;justify-content:center;">${fallbackSvg}</span>`;
  }
  return fallbackSvg;
}

export function getLocalizedAppTitle(appDef) {
  if (!appDef) return '';
  if (appDef.app_type === 'system') {
    const key = `apps.${appDef.app_id}.title`;
    const translated = t(key);
    if (translated !== key) return translated;
  }
  if (appDef.name_i18n) {
    return resolveLocalized(appDef.name_i18n, appDef.title);
  }
  return appDef.title || appDef.app_id;
}

export function getLocalizedAppSubtitle(appDef) {
  if (!appDef) return '';
  if (appDef.app_type === 'system') {
    const key = `apps.${appDef.app_id}.subtitle`;
    const translated = t(key);
    if (translated !== key) return translated;
  }
  if (appDef.desc_i18n) {
    return resolveLocalized(appDef.desc_i18n, appDef.subtitle || '');
  }
  return appDef.subtitle || '';
}

export class WindowManager {
  constructor({ containerEl, snapPreviewEl, onStateChange }) {
    this.containerEl = containerEl;
    this.snapPreviewEl = snapPreviewEl;
    this.onStateChange = onStateChange || (() => {});
    this.windows = new Map();
    this.zCounter = 100;
    this.focusedId = null;
    this.windowRects = {}; // appId -> { left, top, width, height }
    this.rectSyncTimer = null;

    try {
      const cached = JSON.parse(localStorage.getItem('vanillia_win_rects') || '{}');
      if (cached && typeof cached === 'object') {
        this.windowRects = cached;
      }
    } catch (_) {}

    window.addEventListener('keydown', (e) => {
      if (e.altKey && e.key.toLowerCase() === 'w' && this.focusedId) {
        e.preventDefault();
        this.close(this.focusedId);
      }
    });

    // Automatic off-screen recovery on viewport resize (e.g. 4K -> 1080p)
    let resizeDebounce = null;
    window.addEventListener('resize', () => {
      if (resizeDebounce) clearTimeout(resizeDebounce);
      resizeDebounce = setTimeout(() => this.ensureAllWindowsInViewport(), 120);
    });

    // Live translation of open window titles & button tooltips when language changes
    window.addEventListener('vanillia:lang-changed', () => {
      for (const record of this.windows.values()) {
        if (record.appDef) {
          record.title = getLocalizedAppTitle(record.appDef);
          const titleEl = record.el.querySelector('.win-title');
          if (titleEl) titleEl.textContent = record.title;
        }
        record.el.querySelector('.win-ctrl-btn.minimize')?.setAttribute('title', t('window.minimize'));
        record.el.querySelector('.win-ctrl-btn.maximize')?.setAttribute('title', t('window.maximize'));
        record.el.querySelector('.win-ctrl-btn.close')?.setAttribute('title', t('window.close'));
      }
      this.emitChange();
    });
  }

  loadSavedRectsFromUser(userPrefs) {
    if (userPrefs && userPrefs.windowRects && typeof userPrefs.windowRects === 'object') {
      this.windowRects = { ...this.windowRects, ...userPrefs.windowRects };
    }
  }

  persistRect(appId, rect) {
    if (!appId || !rect) return;
    this.windowRects[appId] = {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    try {
      localStorage.setItem('vanillia_win_rects', JSON.stringify(this.windowRects));
    } catch (_) {}

    if (this.rectSyncTimer) clearTimeout(this.rectSyncTimer);
    this.rectSyncTimer = setTimeout(() => {
      api.post('/api/settings.php?action=desktop_layout', { window_rects: this.windowRects }).catch(() => {});
    }, 600);
  }

  isMobileViewport() {
    return window.matchMedia('(max-width: 860px)').matches;
  }

  getWorkspaceBounds() {
    const rect = this.containerEl.getBoundingClientRect();
    const dockReserve = this.isMobileViewport() ? 0 : 78;
    const w = rect.width || window.innerWidth;
    const h = rect.height || (window.innerHeight - 38);
    return {
      width: Math.max(320, w),
      height: Math.max(260, h - dockReserve),
      fullHeight: Math.max(260, h),
    };
  }

  /**
   * Checks if `rect` overflows or lies outside the current viewport; if so, centers it cleanly.
   */
  sanitizeWindowRect(rect, bounds) {
    const width = Math.min(Math.max(360, rect.width || 920), Math.max(360, bounds.width - 20));
    const height = Math.min(Math.max(260, rect.height || 600), Math.max(260, bounds.height - 16));

    let { left, top } = rect;
    const outHoriz = left === undefined || left < 0 || (left + width) > (bounds.width + 24) || left > (bounds.width - 100);
    const outVert = top === undefined || top < 0 || (top + 44) > bounds.fullHeight || (top + height) > (bounds.fullHeight + 40);

    const recentered = outHoriz || outVert;
    if (recentered) {
      left = Math.max(10, Math.round((bounds.width - width) / 2));
      top = Math.max(8, Math.round((bounds.height - height) / 2));
    }

    return { left, top, width, height, recentered };
  }

  ensureAllWindowsInViewport() {
    if (this.isMobileViewport()) return;
    const bounds = this.getWorkspaceBounds();

    for (const record of this.windows.values()) {
      if (record.maximized) {
        record.el.style.left = '0px';
        record.el.style.top = '0px';
        record.el.style.width = `${bounds.width}px`;
        record.el.style.height = `${bounds.height}px`;
        continue;
      }

      const currentRect = {
        left: parseFloat(record.el.style.left) || 0,
        top: parseFloat(record.el.style.top) || 0,
        width: record.el.offsetWidth || record.savedRect.width,
        height: record.el.offsetHeight || record.savedRect.height,
      };

      const safe = this.sanitizeWindowRect(currentRect, bounds);
      if (safe.recentered || safe.width !== currentRect.width || safe.height !== currentRect.height) {
        record.el.style.left = `${safe.left}px`;
        record.el.style.top = `${safe.top}px`;
        record.el.style.width = `${safe.width}px`;
        record.el.style.height = `${safe.height}px`;
        record.savedRect = { left: safe.left, top: safe.top, width: safe.width, height: safe.height };
        this.persistRect(record.appId, record.savedRect);
      }
    }
  }

  centerWindow(winId) {
    const record = this.windows.get(winId);
    if (!record) return;

    if (record.minimized) {
      record.minimized = false;
      record.el.classList.remove('is-minimized');
    }
    if (record.maximized) {
      record.maximized = false;
      record.el.classList.remove('is-maximized');
    }

    const bounds = this.getWorkspaceBounds();
    const width = Math.min(Math.max(360, record.savedRect.width || 920), Math.max(360, bounds.width - 24));
    const height = Math.min(Math.max(260, record.savedRect.height || 600), Math.max(260, bounds.height - 20));
    const left = Math.max(10, Math.round((bounds.width - width) / 2));
    const top = Math.max(8, Math.round((bounds.height - height) / 2));

    record.el.style.left = `${left}px`;
    record.el.style.top = `${top}px`;
    record.el.style.width = `${width}px`;
    record.el.style.height = `${height}px`;
    record.savedRect = { left, top, width, height };

    this.persistRect(record.appId, record.savedRect);
    this.focus(winId);
  }

  closeAllAndResetPositions() {
    for (const winId of Array.from(this.windows.keys())) {
      const record = this.windows.get(winId);
      if (record && typeof record.cleanup === 'function') {
        try { record.cleanup(); } catch (_) {}
      }
      record?.el.remove();
      this.windows.delete(winId);
    }
    this.focusedId = null;
    this.windowRects = {};
    try {
      localStorage.removeItem('vanillia_win_rects');
    } catch (_) {}

    api.post('/api/settings.php?action=desktop_layout', { window_rects: null }).catch(() => {});
    this.emitChange();
  }

  findByAppId(appId) {
    for (const win of this.windows.values()) {
      if (win.appId === appId) return win;
    }
    return null;
  }

  async open(appDef, launchParams = {}) {
    const resolvedUrl = appDef.url || appDef.target_url || '';

    // 1. External browser tab (`launchMode: "external"`, `open_mode: "external"` or `"tab"`)
    if ((appDef.launch_mode === 'external' || appDef.open_mode === 'external' || appDef.open_mode === 'tab') && resolvedUrl) {
      window.open(resolvedUrl, '_blank', 'noopener,noreferrer');
      return null;
    }

    // 2. Isolated VPS Remote Browser (`open_mode: "remote_browser"`)
    if (appDef.open_mode === 'remote_browser' && resolvedUrl) {
      window.__VANILLIA_DESKTOP__?.launchAppById('web-browser', { url: resolvedUrl });
      return null;
    }

    const existing = this.findByAppId(appDef.app_id);
    if (existing) {
      if (existing.minimized) {
        this.restore(existing.id);
      } else {
        this.focus(existing.id);
      }
      // Ensure existing window is inside current viewport if screen size changed
      this.ensureAllWindowsInViewport();
      if (typeof existing.instanceOnLaunch === 'function' && Object.keys(launchParams).length > 0) {
        existing.instanceOnLaunch(launchParams);
      }
      return existing;
    }

    const winId = `win-${appDef.app_id.replace(/[^a-zA-Z0-9_-]/g, '-')}-${Date.now().toString(36)}`;
    const bounds = this.getWorkspaceBounds();
    const memorized = this.windowRects[appDef.app_id];

    let initialRect;
    if (memorized) {
      initialRect = this.sanitizeWindowRect(memorized, bounds);
      if (initialRect.recentered) {
        this.persistRect(appDef.app_id, initialRect);
      }
    } else {
      const count = this.windows.size;
      const width = Math.min(appDef.defaultWidth || 920, Math.max(360, bounds.width - 36));
      const height = Math.min(appDef.defaultHeight || 600, Math.max(300, bounds.height - 24));
      const cascade = (count % 5) * 24;
      const candidate = {
        left: Math.round((bounds.width - width) / 2) + cascade - 24,
        top: Math.round((bounds.height - height) / 2) + cascade - 18,
        width,
        height,
      };
      initialRect = this.sanitizeWindowRect(candidate, bounds);
    }

    const { left, top, width, height } = initialRect;
    const el = document.createElement('section');
    el.className = 'os-window';
    el.dataset.winId = winId;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;

    const accent = appDef.accent_color || '#FF6D5A';
    const localizedTitle = getLocalizedAppTitle(appDef);

    el.innerHTML = `
      <header class="win-header">
        <div class="win-title-group">
          <span class="win-app-badge" style="background:${accent}">${renderAppVisualIcon(appDef)}</span>
          <span class="win-title"></span>
        </div>
        <div class="win-controls">
          <span class="win-extra-actions" style="display:inline-flex;gap:4px;"></span>
          <button type="button" class="win-ctrl-btn minimize" title="${t('window.minimize')}">${Icons.minimize}</button>
          <button type="button" class="win-ctrl-btn maximize" title="${t('window.maximize')}">${Icons.maximize}</button>
          <button type="button" class="win-ctrl-btn close" title="${t('window.close')}">${Icons.close}</button>
        </div>
      </header>
      <div class="win-body"></div>
      <div class="win-resize win-resize-n" data-dir="n"></div>
      <div class="win-resize win-resize-s" data-dir="s"></div>
      <div class="win-resize win-resize-e" data-dir="e"></div>
      <div class="win-resize win-resize-w" data-dir="w"></div>
      <div class="win-resize win-resize-ne" data-dir="ne"></div>
      <div class="win-resize win-resize-nw" data-dir="nw"></div>
      <div class="win-resize win-resize-se" data-dir="se"></div>
      <div class="win-resize win-resize-sw" data-dir="sw"></div>
    `;

    el.querySelector('.win-title').textContent = localizedTitle;

    const record = {
      id: winId,
      appId: appDef.app_id,
      appDef,
      title: localizedTitle,
      icon: appDef.icon || 'box',
      iconUrl: appDef.icon_url || null,
      accentColor: accent,
      el,
      bodyEl: el.querySelector('.win-body'),
      extraActionsEl: el.querySelector('.win-extra-actions'),
      minimized: false,
      maximized: false,
      savedRect: { left, top, width, height },
      cleanup: null,
      instanceOnLaunch: null,
    };

    this.bindWindowEvents(record);
    this.containerEl.appendChild(el);
    this.windows.set(winId, record);
    this.focus(winId);

    await this.mountWindowContent(record, appDef, launchParams);
    this.emitChange();
    return record;
  }

  bindWindowEvents(record) {
    const { el, id } = record;
    const header = el.querySelector('.win-header');
    const btnMin = el.querySelector('.win-ctrl-btn.minimize');
    const btnMax = el.querySelector('.win-ctrl-btn.maximize');
    const btnClose = el.querySelector('.win-ctrl-btn.close');

    el.addEventListener('pointerdown', () => this.focus(id));
    btnMin.addEventListener('click', (e) => {
      e.stopPropagation();
      this.minimize(id);
    });
    btnMax.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMaximize(id);
    });
    btnClose.addEventListener('click', (e) => {
      e.stopPropagation();
      this.close(id);
    });
    header.addEventListener('dblclick', (e) => {
      if (!e.target.closest('.win-controls') && !this.isMobileViewport()) {
        this.toggleMaximize(id);
      }
    });

    // Smooth Drag & Drop + Edge Snap + Coordinate Persistence
    header.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.win-controls') || this.isMobileViewport()) {
        return;
      }
      this.focus(id);

      const startX = e.clientX;
      const startY = e.clientY;

      if (record.maximized) {
        const ratio = e.clientX / window.innerWidth;
        record.maximized = false;
        el.classList.remove('is-maximized');
        const w = record.savedRect.width;
        const h = record.savedRect.height;
        const restoredLeft = Math.max(8, Math.round(e.clientX - w * ratio));
        el.style.width = `${w}px`;
        el.style.height = `${h}px`;
        el.style.left = `${restoredLeft}px`;
        el.style.top = '8px';
      }

      const initLeft = parseFloat(el.style.left) || 0;
      const initTop = parseFloat(el.style.top) || 0;
      let pendingSnap = null;

      el.classList.add('is-interacting');
      document.body.classList.add('is-dragging-window');
      header.setPointerCapture(e.pointerId);

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        const bounds = this.getWorkspaceBounds();
        const nextLeft = Math.max(0, Math.min(bounds.width - 120, initLeft + dx));
        const nextTop = Math.max(0, Math.min(bounds.fullHeight - 44, initTop + dy));

        el.style.left = `${nextLeft}px`;
        el.style.top = `${nextTop}px`;

        if (ev.clientX <= 14) {
          pendingSnap = 'left';
          this.showSnapPreview('left');
        } else if (ev.clientX >= window.innerWidth - 14) {
          pendingSnap = 'right';
          this.showSnapPreview('right');
        } else if (ev.clientY <= 44) {
          pendingSnap = 'maximize';
          this.showSnapPreview('maximize');
        } else {
          pendingSnap = null;
          this.hideSnapPreview();
        }
      };

      const onUp = () => {
        header.removeEventListener('pointermove', onMove);
        header.removeEventListener('pointerup', onUp);
        header.removeEventListener('pointercancel', onUp);
        el.classList.remove('is-interacting');
        document.body.classList.remove('is-dragging-window');
        this.hideSnapPreview();

        if (pendingSnap === 'maximize') {
          this.toggleMaximize(id, true);
        } else if (pendingSnap === 'left' || pendingSnap === 'right') {
          this.snapSide(id, pendingSnap);
        } else {
          record.savedRect = {
            left: parseFloat(el.style.left) || 0,
            top: parseFloat(el.style.top) || 0,
            width: el.offsetWidth,
            height: el.offsetHeight,
          };
          this.persistRect(record.appId, record.savedRect);
        }
      };

      header.addEventListener('pointermove', onMove);
      header.addEventListener('pointerup', onUp);
      header.addEventListener('pointercancel', onUp);
    });

    // 8-Direction Resize
    el.querySelectorAll('.win-resize').forEach((handle) => {
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || record.maximized || this.isMobileViewport()) return;
        e.stopPropagation();
        this.focus(id);

        const dir = handle.dataset.dir || 'se';
        const startX = e.clientX;
        const startY = e.clientY;
        const startRect = {
          left: parseFloat(el.style.left) || 0,
          top: parseFloat(el.style.top) || 0,
          width: el.offsetWidth,
          height: el.offsetHeight,
        };
        const minW = 360;
        const minH = 260;

        el.classList.add('is-interacting');
        document.body.classList.add('is-dragging-window');
        handle.setPointerCapture(e.pointerId);

        const onMove = (ev) => {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          let { left, top, width, height } = startRect;

          if (dir.includes('e')) width = Math.max(minW, startRect.width + dx);
          if (dir.includes('s')) height = Math.max(minH, startRect.height + dy);
          if (dir.includes('w')) {
            const candidateW = startRect.width - dx;
            if (candidateW >= minW && startRect.left + dx >= 0) {
              width = candidateW;
              left = startRect.left + dx;
            }
          }
          if (dir.includes('n')) {
            const candidateH = startRect.height - dy;
            if (candidateH >= minH && startRect.top + dy >= 0) {
              height = candidateH;
              top = startRect.top + dy;
            }
          }

          el.style.left = `${left}px`;
          el.style.top = `${top}px`;
          el.style.width = `${width}px`;
          el.style.height = `${height}px`;
        };

        const onUp = () => {
          handle.removeEventListener('pointermove', onMove);
          handle.removeEventListener('pointerup', onUp);
          handle.removeEventListener('pointercancel', onUp);
          el.classList.remove('is-interacting');
          document.body.classList.remove('is-dragging-window');
          record.savedRect = {
            left: parseFloat(el.style.left) || 0,
            top: parseFloat(el.style.top) || 0,
            width: el.offsetWidth,
            height: el.offsetHeight,
          };
          this.persistRect(record.appId, record.savedRect);
        };

        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
      });
    });
  }

  showSnapPreview(mode) {
    if (!this.snapPreviewEl) return;
    const topOffset = this.containerEl.getBoundingClientRect().top;
    const bounds = this.getWorkspaceBounds();

    this.snapPreviewEl.classList.remove('hidden');
    if (mode === 'left') {
      this.snapPreviewEl.style.top = `${topOffset + 8}px`;
      this.snapPreviewEl.style.left = '8px';
      this.snapPreviewEl.style.width = `${Math.round(bounds.width / 2) - 12}px`;
      this.snapPreviewEl.style.height = `${bounds.height - 16}px`;
    } else if (mode === 'right') {
      this.snapPreviewEl.style.top = `${topOffset + 8}px`;
      this.snapPreviewEl.style.left = `${Math.round(bounds.width / 2) + 4}px`;
      this.snapPreviewEl.style.width = `${Math.round(bounds.width / 2) - 12}px`;
      this.snapPreviewEl.style.height = `${bounds.height - 16}px`;
    } else {
      this.snapPreviewEl.style.top = `${topOffset + 6}px`;
      this.snapPreviewEl.style.left = '6px';
      this.snapPreviewEl.style.width = `${bounds.width - 12}px`;
      this.snapPreviewEl.style.height = `${bounds.height - 12}px`;
    }
  }

  hideSnapPreview() {
    this.snapPreviewEl?.classList.add('hidden');
  }

  snapSide(winId, side) {
    const record = this.windows.get(winId);
    if (!record) return;
    const bounds = this.getWorkspaceBounds();
    const halfW = Math.round(bounds.width / 2) - 8;

    record.maximized = false;
    record.el.classList.remove('is-maximized');
    record.el.style.top = '6px';
    record.el.style.left = side === 'left' ? '6px' : `${Math.round(bounds.width / 2) + 2}px`;
    record.el.style.width = `${halfW}px`;
    record.el.style.height = `${bounds.height - 12}px`;
    record.savedRect = {
      left: parseFloat(record.el.style.left) || 0,
      top: 6,
      width: halfW,
      height: bounds.height - 12,
    };
    this.persistRect(record.appId, record.savedRect);
  }

  focus(winId) {
    const record = this.windows.get(winId);
    if (!record) return;

    this.zCounter += 1;
    record.el.style.zIndex = String(this.zCounter);
    this.focusedId = winId;

    for (const [id, win] of this.windows.entries()) {
      win.el.classList.toggle('is-focused', id === winId && !win.minimized);
    }
    this.emitChange();
  }

  minimize(winId) {
    const record = this.windows.get(winId);
    if (!record) return;
    record.minimized = true;
    record.el.classList.add('is-minimized');
    record.el.classList.remove('is-focused');

    if (this.focusedId === winId) {
      this.focusedId = null;
      let best = null;
      for (const win of this.windows.values()) {
        if (!win.minimized && (!best || Number(win.el.style.zIndex) > Number(best.el.style.zIndex))) {
          best = win;
        }
      }
      if (best) this.focus(best.id);
    }
    this.emitChange();
  }

  restore(winId) {
    const record = this.windows.get(winId);
    if (!record) return;
    record.minimized = false;
    record.el.classList.remove('is-minimized');
    this.ensureAllWindowsInViewport();
    this.focus(winId);
  }

  toggleFromDock(appDef) {
    const existing = this.findByAppId(appDef.app_id);
    if (!existing) {
      this.open(appDef);
      return;
    }
    if (existing.minimized) {
      this.restore(existing.id);
    } else if (this.focusedId === existing.id) {
      this.minimize(existing.id);
    } else {
      this.focus(existing.id);
    }
  }

  toggleMaximize(winId, forceMax = null) {
    const record = this.windows.get(winId);
    if (!record) return;
    const shouldMax = forceMax !== null ? forceMax : !record.maximized;

    if (shouldMax) {
      if (!record.maximized) {
        record.savedRect = {
          left: parseFloat(record.el.style.left) || 0,
          top: parseFloat(record.el.style.top) || 0,
          width: record.el.offsetWidth,
          height: record.el.offsetHeight,
        };
      }
      const bounds = this.getWorkspaceBounds();
      record.maximized = true;
      record.el.classList.add('is-maximized');
      record.el.style.left = '0px';
      record.el.style.top = '0px';
      record.el.style.width = `${bounds.width}px`;
      record.el.style.height = `${bounds.height}px`;
    } else {
      record.maximized = false;
      record.el.classList.remove('is-maximized');
      const safe = this.sanitizeWindowRect(record.savedRect, this.getWorkspaceBounds());
      record.el.style.left = `${safe.left}px`;
      record.el.style.top = `${safe.top}px`;
      record.el.style.width = `${safe.width}px`;
      record.el.style.height = `${safe.height}px`;
    }
  }

  close(winId) {
    const record = this.windows.get(winId);
    if (!record) return;
    if (typeof record.cleanup === 'function') {
      try { record.cleanup(); } catch (_) {}
    }
    record.el.remove();
    this.windows.delete(winId);

    if (this.focusedId === winId) {
      this.focusedId = null;
      let best = null;
      for (const win of this.windows.values()) {
        if (!win.minimized && (!best || Number(win.el.style.zIndex) > Number(best.el.style.zIndex))) {
          best = win;
        }
      }
      if (best) this.focus(best.id);
    }
    this.emitChange();
  }

  minimizeAll() {
    for (const win of this.windows.values()) {
      win.minimized = true;
      win.el.classList.add('is-minimized');
      win.el.classList.remove('is-focused');
    }
    this.focusedId = null;
    this.emitChange();
  }

  emitChange() {
    const active = this.focusedId ? this.windows.get(this.focusedId) : null;
    this.onStateChange({
      activeWindow: active || null,
      windows: Array.from(this.windows.values()),
    });
  }

  async mountWindowContent(record, appDef, launchParams) {
    const { bodyEl } = record;

    // 1. Dynamic Plugin (`launchMode: "window"`), Web Shortcut (`open_mode: "window"`), or Container Iframe
    const embedUrl = appDef.url || appDef.target_url || '';
    if ((appDef.app_type === 'plugin' || appDef.app_type === 'shortcut' || appDef.open_mode === 'iframe') && embedUrl) {
      const isSandboxed = appDef.app_type === 'plugin' || appDef.app_type === 'shortcut';
      const sandboxAttr = isSandboxed
        ? 'sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"'
        : '';

      const showFrameHint = appDef.app_type === 'shortcut' || /^https?:\/\//i.test(embedUrl);

      bodyEl.innerHTML = `
        <div class="win-iframe-stack">
          <div class="win-iframe-bar">
            <span class="win-iframe-url" style="font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
            <div style="display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;">
              <button type="button" class="os-btn os-btn-ghost" data-act="vps-browser" style="padding:4px 9px;font-size:0.74rem;border-color:rgba(59,130,246,0.4);">🌐 <span data-i18n="window.open_vps_browser">${t('window.open_vps_browser')}</span></button>
              <button type="button" class="os-btn os-btn-ghost" data-act="reload" style="padding:4px 9px;font-size:0.74rem;">${Icons.refresh} <span data-i18n="common.refresh">${t('common.refresh')}</span></button>
              <button type="button" class="os-btn os-btn-ghost" data-act="ext" style="padding:4px 9px;font-size:0.74rem;">${Icons.external} <span data-i18n="common.new_tab">${t('common.new_tab')}</span></button>
            </div>
          </div>
          ${showFrameHint ? `
            <div class="win-iframe-hint">
              <span data-i18n="window.iframe_hint">${t('window.iframe_hint')}</span>
              <button type="button" data-act="dismiss-hint" style="opacity:0.7;font-size:0.78rem;padding:0 4px;" title="${t('common.close')}">✕</button>
            </div>
          ` : ''}
          <iframe class="win-iframe" ${sandboxAttr} referrerpolicy="no-referrer" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
        </div>
      `;
      bodyEl.querySelector('.win-iframe-url').textContent = embedUrl;
      const iframe = bodyEl.querySelector('iframe');
      iframe.src = embedUrl;

      bodyEl.querySelector('[data-act="vps-browser"]').addEventListener('click', () => {
        window.__VANILLIA_DESKTOP__?.launchAppById('web-browser', { url: embedUrl });
      });
      bodyEl.querySelector('[data-act="reload"]').addEventListener('click', () => {
        iframe.src = embedUrl;
      });
      bodyEl.querySelector('[data-act="ext"]').addEventListener('click', () => {
        window.open(embedUrl, '_blank', 'noopener,noreferrer');
      });
      bodyEl.querySelector('[data-act="dismiss-hint"]')?.addEventListener('click', (e) => {
        e.currentTarget.closest('.win-iframe-hint')?.remove();
      });
      return;
    }

    // 2. Native System ES6 Module (/assets/js/apps/<appId>.js)
    try {
      const mod = await import(`../apps/${appDef.app_id}.js`);
      if (mod && typeof mod.mountApp === 'function') {
        const handle = await mod.mountApp({
          container: bodyEl,
          app: appDef,
          params: launchParams,
          api,
          windowRecord: record,
        });
        if (handle && typeof handle.cleanup === 'function') {
          record.cleanup = handle.cleanup;
        }
        if (handle && typeof handle.onLaunch === 'function') {
          record.instanceOnLaunch = handle.onLaunch;
        }
        return;
      }
    } catch (err) {
      bodyEl.innerHTML = `
        <div class="app-pane">
          <div class="os-alert os-alert-error">Failed to load module "${appDef.app_id}": ${err.message}</div>
        </div>
      `;
    }
  }
}
