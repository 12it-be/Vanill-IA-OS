/**
 * ==============================================================================
 * Vanill-IA OS — Hybrid Desktop, i18n, Drag-Reorder Icons, Plugins & PWA Controller
 * ==============================================================================
 */

import { api } from './ApiClient.js';
import { renderQrCodeSvg } from './QrCode.js';
import { initI18n, t, setLanguage, getLanguage, getLocaleTag, applyTranslations } from '../i18n.js';
import {
  WindowManager,
  getAppIconSvg,
  renderAppVisualIcon,
  getLocalizedAppTitle,
  getLocalizedAppSubtitle,
} from './WindowManager.js';

class VanillIADesktop {
  constructor() {
    this.state = {
      authenticated: false,
      locked: false,
      setupRequired: false,
      requiresSetupToken: false,
      isLocalNetwork: true,
      user: null,
      os: {},
      shortcuts: [],
      desktopOrder: [],
      hiddenDesktopApps: [],
      pinnedPluginDock: [],
      pulseTimer: null,
      clockTimer: null,
      deferredInstallPrompt: null,
    };

    this.els = {
      authLayer: document.getElementById('authLayer'),
      lockLayer: document.getElementById('lockLayer'),
      topbar: document.getElementById('osTopbar'),
      desktop: document.getElementById('osDesktop'),
      iconsGrid: document.getElementById('desktopIconsGrid'),
      windowsLayer: document.getElementById('windowsLayer'),
      snapPreview: document.getElementById('snapPreview'),
      dockWrap: document.getElementById('osDockWrap'),
      dock: document.getElementById('osDock'),
      mobileHero: document.getElementById('mobileHeroCard'),
      mobileTaskbar: document.getElementById('mobileTaskbar'),
      spotlightBackdrop: document.getElementById('spotlightBackdrop'),
      spotlightInput: document.getElementById('spotlightInput'),
      spotlightResults: document.getElementById('spotlightResults'),
      desktopModalLayer: document.getElementById('desktopModalLayer'),
      notifDrawer: document.getElementById('notifDrawer'),
      notifList: document.getElementById('notifList'),
      notifBadge: document.getElementById('notifBadge'),
      powerPopover: document.getElementById('powerPopover'),
      contextMenu: document.getElementById('contextMenu'),
      toastStack: document.getElementById('toastStack'),
      activeAppTitle: document.getElementById('activeAppTitle'),
      closeAllBtn: document.getElementById('closeAllWindowsBtn'),
      cpuText: document.getElementById('topbarCpuText'),
      cpuBar: document.getElementById('topbarCpuBar'),
      ramText: document.getElementById('topbarRamText'),
      ramBar: document.getElementById('topbarRamBar'),
      clockText: document.getElementById('topbarClock'),
      pwaInstallBtn: document.getElementById('pwaInstallBtn'),
    };

    this.wm = new WindowManager({
      containerEl: this.els.windowsLayer,
      snapPreviewEl: this.els.snapPreview,
      onStateChange: (winState) => this.onWindowsStateChanged(winState),
    });
  }

  async init() {
    await initI18n('en');
    this.registerPwaLifecycle();
    this.bindGlobalEvents();
    this.startClock();

    try {
      const status = await api.get('/api/auth.php?action=status');
      this.state.setupRequired = Boolean(status.setup_required);
      this.state.requiresSetupToken = Boolean(status.requires_setup_token);
      this.state.isLocalNetwork = Boolean(status.is_local_network);
      this.state.authenticated = Boolean(status.authenticated);
      this.state.locked = Boolean(status.locked);
      this.state.user = status.user || null;
      this.state.os = status.os || {};

      if (this.state.user?.language) {
        setLanguage(this.state.user.language);
      } else {
        setLanguage('en');
      }

      if (this.state.setupRequired) {
        this.renderSetupWizard();
        return;
      }

      if (!this.state.authenticated) {
        this.renderLoginScreen();
        return;
      }

      await this.enterDesktop();
      if (this.state.locked) {
        this.showLockScreen();
      }
    } catch (err) {
      this.toast(err.message || 'Initialization error.', 'error');
    }
  }

  registerPwaLifecycle() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
          .then((reg) => reg.update().catch(() => {}))
          .catch(() => {});
      });
    }

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.state.deferredInstallPrompt = e;
      this.els.pwaInstallBtn?.classList.remove('hidden');
    });

    window.addEventListener('appinstalled', () => {
      this.state.deferredInstallPrompt = null;
      this.els.pwaInstallBtn?.classList.add('hidden');
      this.toast(t('auth.pwa_installed'));
    });

    this.els.pwaInstallBtn?.addEventListener('click', async () => {
      if (this.state.deferredInstallPrompt) {
        this.state.deferredInstallPrompt.prompt();
        await this.state.deferredInstallPrompt.userChoice;
        this.state.deferredInstallPrompt = null;
        this.els.pwaInstallBtn.classList.add('hidden');
      } else {
        this.toast(t('auth.pwa_ios_hint'));
      }
    });
  }

  bindGlobalEvents() {
    window.addEventListener('vanillia:session-locked', () => {
      if (this.state.authenticated) {
        this.state.locked = true;
        this.showLockScreen();
      }
    });

    window.addEventListener('vanillia:auth-expired', () => {
      this.stopPulse();
      this.state.authenticated = false;
      this.renderLoginScreen();
    });

    // Live UI translation without closing open windows
    window.addEventListener('vanillia:lang-changed', () => {
      applyTranslations(document);
      if (this.state.authenticated) {
        this.renderDesktopIcons();
        this.renderDock();
        const active = this.wm.focusedId ? this.wm.windows.get(this.wm.focusedId) : null;
        this.els.activeAppTitle.textContent = active ? active.title : t('topbar.desktop');
      }
    });

    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && this.state.authenticated && !this.state.locked) {
        e.preventDefault();
        this.toggleSpotlight();
      } else if (e.key === 'Escape') {
        this.closeFloatingPanels();
      }
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('#contextMenu')) {
        this.els.contextMenu.classList.add('hidden');
      }
      if (!e.target.closest('#powerPopover') && !e.target.closest('#powerMenuBtn')) {
        this.els.powerPopover.classList.add('hidden');
      }
      if (!e.target.closest('#notifDrawer') && !e.target.closest('#notifToggleBtn')) {
        this.els.notifDrawer.classList.add('hidden');
      }
    });

    // Desktop right-click context menu
    this.els.desktop.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.os-window')) return;
      e.preventDefault();
      const iconItem = e.target.closest('.desktop-icon-item');
      const appId = iconItem ? iconItem.dataset.appId : null;
      this.openContextMenu(e.clientX, e.clientY, appId);
    });

    // Topbar actions
    document.getElementById('launcherMenuBtn')?.addEventListener('click', () => this.toggleSpotlight());
    document.getElementById('spotlightTriggerBtn')?.addEventListener('click', () => this.toggleSpotlight());
    document.getElementById('topbarMetricsBtn')?.addEventListener('click', () => this.launchAppById('resource-monitor'));

    // Close All Windows + Reset Positions button
    this.els.closeAllBtn?.addEventListener('click', () => {
      this.wm.closeAllAndResetPositions();
      this.toast(t('window.all_closed_toast'));
    });

    document.getElementById('themeSwitchBtn')?.addEventListener('click', async () => {
      const next = (this.state.user?.theme_mode || 'dark') === 'dark' ? 'light' : 'dark';
      try {
        const res = await api.post('/api/settings.php?action=preferences', { theme_mode: next });
        this.applyUserPreferences(res.user);
      } catch (err) {
        this.toast(err.message, 'error');
      }
    });

    document.getElementById('notifToggleBtn')?.addEventListener('click', () => this.toggleNotificationsDrawer());
    document.getElementById('markAllReadBtn')?.addEventListener('click', async () => {
      const res = await api.post('/api/notifications.php?action=read', {});
      this.updateBellBadge(res.unread_count || 0);
      await this.loadNotifications();
    });
    document.getElementById('clearNotifsBtn')?.addEventListener('click', async () => {
      await api.post('/api/notifications.php?action=clear', {});
      this.updateBellBadge(0);
      await this.loadNotifications();
    });

    document.getElementById('powerMenuBtn')?.addEventListener('click', () => {
      this.els.powerPopover.classList.toggle('hidden');
    });

    this.els.powerPopover.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-power]');
      if (!btn) return;
      const act = btn.dataset.power;
      this.els.powerPopover.classList.add('hidden');

      if (act === 'lock') {
        await api.post('/api/auth.php?action=lock');
        this.state.locked = true;
        this.showLockScreen();
      } else if (act === 'settings') {
        this.launchAppById('system-settings', { section: 'security' });
      } else if (act === 'logout') {
        await api.post('/api/auth.php?action=logout');
        this.stopPulse();
        this.state.authenticated = false;
        this.renderLoginScreen();
      } else if (act === 'reboot' || act === 'poweroff') {
        const promptKey = act === 'reboot' ? 'power.confirm_reboot' : 'power.confirm_poweroff';
        if (window.confirm(t(promptKey))) {
          try {
            await api.post('/api/system.php?action=power', { mode: act });
            if (act === 'reboot') {
              window.location.href = '/offline.html';
            } else {
              this.toast(t('power.poweroff_scheduled'));
            }
          } catch (err) {
            this.toast(err.message, 'error');
          }
        }
      }
    });

    this.els.spotlightBackdrop.addEventListener('click', (e) => {
      if (e.target === this.els.spotlightBackdrop) {
        this.els.spotlightBackdrop.classList.add('hidden');
      }
    });
    this.els.desktopModalLayer.addEventListener('click', (e) => {
      if (e.target === this.els.desktopModalLayer) {
        this.els.desktopModalLayer.classList.add('hidden');
      }
    });
    this.els.spotlightInput.addEventListener('input', () => {
      this.renderSpotlightItems(this.els.spotlightInput.value);
    });
    this.els.spotlightInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = this.els.spotlightResults.querySelector('[data-spot-open]');
        if (first) first.click();
      }
    });

    document.getElementById('mobHomeBtn')?.addEventListener('click', () => this.wm.minimizeAll());
    document.getElementById('mobSearchBtn')?.addEventListener('click', () => this.toggleSpotlight());
    document.getElementById('mobLockBtn')?.addEventListener('click', async () => {
      await api.post('/api/auth.php?action=lock');
      this.state.locked = true;
      this.showLockScreen();
    });
  }

  closeFloatingPanels() {
    this.els.spotlightBackdrop.classList.add('hidden');
    this.els.desktopModalLayer.classList.add('hidden');
    this.els.notifDrawer.classList.add('hidden');
    this.els.powerPopover.classList.add('hidden');
    this.els.contextMenu.classList.add('hidden');
  }

  // ==========================================================================
  // 1. FIRST BOOT SETUP WIZARD (ENGLISH BY DEFAULT + LANGUAGE SELECTOR)
  // ==========================================================================

  renderSetupWizard() {
    this.hideDesktopChrome();
    this.els.authLayer.classList.remove('hidden');
    const curLang = getLanguage();

    const tokenNotice = this.state.requiresSetupToken
      ? `<div class="os-alert os-alert-info">${this.escapeHtml(t('auth.setup_wan_notice'))}</div>`
      : `<div class="os-alert os-alert-info">${this.escapeHtml(t('auth.setup_lan_notice'))}</div>`;

    this.els.authLayer.innerHTML = `
      <div class="auth-card setup-wide">
        <div class="brand-header">
          <img src="/assets/img/icons/logo.svg" alt="Vanill-IA OS" class="brand-logo">
          <h1>${this.escapeHtml(t('auth.setup_title'))}</h1>
          <p>${this.escapeHtml(t('auth.setup_subtitle'))}</p>
        </div>

        <div id="setupError" class="os-alert os-alert-error hidden"></div>
        ${tokenNotice}

        <form id="setupForm" autocomplete="off">
          <div class="form-group">
            <label class="form-label">${this.escapeHtml(t('auth.language_label'))}</label>
            <select class="os-select" name="language" id="setupLangSelect">
              <option value="en" ${curLang === 'en' ? 'selected' : ''}>English (Default)</option>
              <option value="fr" ${curLang === 'fr' ? 'selected' : ''}>Français</option>
            </select>
          </div>

          <div class="form-group ${this.state.requiresSetupToken ? '' : 'hidden'}" id="setupTokenWrap">
            <label class="form-label">${this.escapeHtml(t('auth.setup_token_label'))}</label>
            <input type="text" class="os-input" name="setup_token" placeholder="A1B2C3D4E5F6..." style="font-family:var(--font-mono);">
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
            <div class="form-group">
              <label class="form-label">${this.escapeHtml(t('auth.admin_username'))}</label>
              <input type="text" class="os-input" name="username" value="admin" required minlength="3" maxlength="32">
            </div>
            <div class="form-group">
              <label class="form-label">${this.escapeHtml(t('auth.display_name'))}</label>
              <input type="text" class="os-input" name="display_name" value="${this.escapeHtml(t('auth.admin_default_name'))}" required>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">${this.escapeHtml(t('auth.strong_password'))}</label>
            <input type="password" class="os-input" name="password" required minlength="10" placeholder="••••••••••••">
          </div>

          <div class="form-group">
            <label style="display:flex;align-items:center;gap:9px;cursor:pointer;font-size:0.86rem;font-weight:600;">
              <input type="checkbox" id="setupEnableTotp">
              ${this.escapeHtml(t('auth.enable_totp_now'))}
            </label>
            <div id="setupTotpPanel" class="totp-setup-box hidden"></div>
          </div>

          <button type="submit" class="os-btn os-btn-primary">${this.escapeHtml(t('auth.setup_submit'))}</button>
        </form>
      </div>
    `;

    const form = this.els.authLayer.querySelector('#setupForm');
    const errBox = this.els.authLayer.querySelector('#setupError');
    const totpCheck = this.els.authLayer.querySelector('#setupEnableTotp');
    const totpPanel = this.els.authLayer.querySelector('#setupTotpPanel');

    this.els.authLayer.querySelector('#setupLangSelect').addEventListener('change', (e) => {
      setLanguage(e.target.value);
      this.renderSetupWizard();
    });

    totpCheck.addEventListener('change', async () => {
      if (!totpCheck.checked) {
        totpPanel.classList.add('hidden');
        totpPanel.innerHTML = '';
        return;
      }
      try {
        const username = form.elements.username.value.trim() || 'admin';
        const prep = await api.post('/api/auth.php?action=setup_prepare_totp', { username });
        const svg = renderQrCodeSvg(prep.otpauth_uri);
        totpPanel.classList.remove('hidden');
        totpPanel.innerHTML = `
          <div class="qr-frame">${svg}</div>
          <p style="text-align:center;font-family:var(--font-mono);font-size:0.76rem;margin-bottom:10px;" class="selectable">${this.escapeHtml(t('auth.secret_label'))}: ${prep.secret}</p>
          <input type="text" class="os-input code-totp" name="totp_code" placeholder="000000" maxlength="6" inputmode="numeric">
        `;
      } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
        totpCheck.checked = false;
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errBox.classList.add('hidden');
      const fd = new FormData(form);

      try {
        const res = await api.post('/api/auth.php?action=setup', {
          setup_token: fd.get('setup_token') || '',
          username: fd.get('username'),
          display_name: fd.get('display_name'),
          language: fd.get('language') || 'en',
          password: fd.get('password'),
          enable_totp: totpCheck.checked,
          totp_code: fd.get('totp_code') || '',
        });

        this.state.setupRequired = false;
        this.state.authenticated = true;
        this.state.locked = false;
        this.state.user = res.user;
        setLanguage(res.user.language || 'en');

        if (Array.isArray(res.backup_codes) && res.backup_codes.length > 0) {
          this.renderBackupCodesInterstitial(res.backup_codes);
        } else {
          await this.enterDesktop();
        }
      } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
        if (err.code === 'INVALID_SETUP_TOKEN') {
          this.els.authLayer.querySelector('#setupTokenWrap')?.classList.remove('hidden');
        }
      }
    });
  }

  renderBackupCodesInterstitial(codes) {
    this.els.authLayer.innerHTML = `
      <div class="auth-card">
        <div class="brand-header">
          <img src="/assets/img/icons/logo.svg" alt="Vanill-IA OS" class="brand-logo">
          <h1>${this.escapeHtml(t('auth.backup_title'))}</h1>
          <p>${this.escapeHtml(t('auth.backup_subtitle'))}</p>
        </div>
        <div class="backup-codes-grid selectable">
          ${codes.map((c) => `<div class="backup-code-chip">${c}</div>`).join('')}
        </div>
        <button type="button" class="os-btn os-btn-primary" id="continueToOsBtn">${this.escapeHtml(t('auth.backup_continue'))}</button>
      </div>
    `;
    this.els.authLayer.querySelector('#continueToOsBtn').addEventListener('click', () => {
      this.enterDesktop();
    });
  }

  // ==========================================================================
  // 2. SIGN IN SCREEN (ENGLISH BY DEFAULT)
  // ==========================================================================

  renderLoginScreen() {
    this.hideDesktopChrome();
    this.els.lockLayer.classList.add('hidden');
    this.els.authLayer.classList.remove('hidden');

    const subtitle = this.state.os.hostname
      ? t('auth.login_subtitle_server', { hostname: this.state.os.hostname })
      : t('auth.login_subtitle_default');

    this.els.authLayer.innerHTML = `
      <div class="auth-card">
        <div class="brand-header">
          <img src="/assets/img/icons/logo.svg" alt="Vanill-IA OS" class="brand-logo">
          <h1>Vanill-IA OS</h1>
          <p>${this.escapeHtml(subtitle)}</p>
        </div>

        <div id="loginError" class="os-alert os-alert-error hidden"></div>

        <form id="loginForm">
          <div id="credentialsStep">
            <div class="form-group">
              <label class="form-label">${this.escapeHtml(t('auth.username'))}</label>
              <input type="text" class="os-input" name="username" autocomplete="username" required autofocus>
            </div>
            <div class="form-group">
              <label class="form-label">${this.escapeHtml(t('auth.password'))}</label>
              <input type="password" class="os-input" name="password" autocomplete="current-password" required>
            </div>
          </div>

          <div id="totpStep" class="hidden">
            <div class="os-alert os-alert-info">${this.escapeHtml(t('auth.totp_prompt'))}</div>
            <div class="form-group">
              <input type="text" class="os-input code-totp" name="totp_code" placeholder="000000" maxlength="9" autocomplete="one-time-code">
            </div>
          </div>

          <button type="submit" class="os-btn os-btn-primary" id="loginSubmitBtn">${this.escapeHtml(t('auth.login_submit'))}</button>
        </form>
      </div>
    `;

    const form = this.els.authLayer.querySelector('#loginForm');
    const errBox = this.els.authLayer.querySelector('#loginError');
    const credStep = this.els.authLayer.querySelector('#credentialsStep');
    const totpStep = this.els.authLayer.querySelector('#totpStep');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errBox.classList.add('hidden');
      const fd = new FormData(form);

      try {
        const res = await api.post('/api/auth.php?action=login', {
          username: fd.get('username'),
          password: fd.get('password'),
          totp_code: fd.get('totp_code') || '',
        });

        if (res.totp_required) {
          credStep.classList.add('hidden');
          totpStep.classList.remove('hidden');
          totpStep.querySelector('input')?.focus();
          return;
        }

        this.state.authenticated = true;
        this.state.locked = false;
        this.state.user = res.user;
        setLanguage(res.user.language || 'en');
        await this.enterDesktop();
      } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
      }
    });
  }

  // ==========================================================================
  // 3. SESSION LOCK SCREEN (PRESERVES OPEN WINDOWS)
  // ==========================================================================

  showLockScreen() {
    this.closeFloatingPanels();
    this.els.lockLayer.classList.remove('hidden');
    const user = this.state.user || {};
    const now = new Date();
    const locale = getLocaleTag();

    this.els.lockLayer.innerHTML = `
      <div>
        <div class="lock-clock" id="lockClockDigits">${now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}</div>
        <div class="lock-date">${now.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' })}</div>

        <div class="auth-card">
          <div class="brand-header" style="margin-bottom:18px;">
            <img src="/assets/img/icons/logo.svg" alt="Vanill-IA OS" class="brand-logo" style="width:52px;height:52px;">
            <h1>${this.escapeHtml(t('auth.lock_title'))}</h1>
            <p>${this.escapeHtml(user.display_name || user.username || 'Admin')} (@${this.escapeHtml(user.username || 'admin')})</p>
          </div>

          <div id="unlockError" class="os-alert os-alert-error hidden"></div>

          <form id="unlockForm">
            <div class="form-group">
              <label class="form-label">${this.escapeHtml(t('auth.lock_password_label'))}</label>
              <input type="password" class="os-input" name="password" required autofocus>
            </div>
            ${user.totp_enabled ? `
              <div class="form-group">
                <label class="form-label">${this.escapeHtml(t('auth.lock_totp_label'))}</label>
                <input type="text" class="os-input code-totp" name="totp_code" placeholder="000000" maxlength="9" required>
              </div>
            ` : ''}
            <button type="submit" class="os-btn os-btn-primary">${this.escapeHtml(t('auth.unlock_submit'))}</button>
            <button type="button" class="os-btn os-btn-ghost" id="switchUserBtn" style="width:100%;margin-top:8px;">${this.escapeHtml(t('auth.switch_user'))}</button>
          </form>
        </div>
      </div>
    `;

    const form = this.els.lockLayer.querySelector('#unlockForm');
    const errBox = this.els.lockLayer.querySelector('#unlockError');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errBox.classList.add('hidden');
      const fd = new FormData(form);
      try {
        const res = await api.post('/api/auth.php?action=unlock', {
          password: fd.get('password'),
          totp_code: fd.get('totp_code') || '',
        }, { silentLock: true });

        this.state.locked = false;
        this.state.user = res.user;
        this.els.lockLayer.classList.add('hidden');
        this.els.lockLayer.innerHTML = '';
        this.fetchPulse();
      } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
      }
    });

    this.els.lockLayer.querySelector('#switchUserBtn').addEventListener('click', async () => {
      await api.post('/api/auth.php?action=logout', {}, { silentLock: true });
      this.els.lockLayer.classList.add('hidden');
      this.stopPulse();
      this.state.authenticated = false;
      this.renderLoginScreen();
    });
  }

  // ==========================================================================
  // 4. DESKTOP WORKSPACE, CUSTOMIZABLE ICON GRID & DOCK
  // ==========================================================================

  hideDesktopChrome() {
    this.els.topbar.classList.add('hidden');
    this.els.desktop.classList.add('hidden');
    this.els.dockWrap.classList.add('hidden');
    this.els.mobileTaskbar.classList.add('hidden');
  }

  async enterDesktop() {
    this.els.authLayer.classList.add('hidden');
    this.els.authLayer.innerHTML = '';

    this.applyUserPreferences(this.state.user);

    this.els.topbar.classList.remove('hidden');
    this.els.desktop.classList.remove('hidden');
    this.els.dockWrap.classList.remove('hidden');
    this.els.mobileTaskbar.classList.remove('hidden');

    await this.loadShortcuts();
    this.startPulse();

    const params = new URLSearchParams(window.location.search);
    const launchId = params.get('launch');
    if (launchId) {
      this.launchAppById(launchId);
      window.history.replaceState({}, '', '/');
    }
  }

  applyUserPreferences(user) {
    if (!user) return;
    this.state.user = user;

    if (user.language && user.language !== getLanguage()) {
      setLanguage(user.language);
    }

    const prefs = user.desktop_prefs || {};
    this.state.desktopOrder = Array.isArray(prefs.desktopOrder) ? [...prefs.desktopOrder] : [];
    this.state.hiddenDesktopApps = Array.isArray(prefs.hiddenDesktopApps) ? [...prefs.hiddenDesktopApps] : [];
    this.state.pinnedPluginDock = Array.isArray(prefs.pinnedPluginDock) ? [...prefs.pinnedPluginDock] : [];
    this.wm.loadSavedRectsFromUser(prefs);

    const theme = user.theme_mode === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-wallpaper', user.wallpaper || 'aurora-coral');
    if (user.accent_color) {
      document.documentElement.style.setProperty('--os-accent', user.accent_color);
    }
  }

  async saveDesktopLayout() {
    try {
      const res = await api.post('/api/settings.php?action=desktop_layout', {
        desktop_order: this.state.desktopOrder,
        hidden_desktop_apps: this.state.hiddenDesktopApps,
        pinned_plugin_dock: this.state.pinnedPluginDock,
      });
      if (res.user) {
        this.state.user = res.user;
      }
    } catch (_) {}
  }

  isAppShownOnDesktop(app) {
    if (this.state.hiddenDesktopApps.includes(app.app_id)) {
      return false;
    }
    return Boolean(app.pinned_desktop);
  }

  isAppPinnedToDock(app) {
    if (app.app_type === 'plugin') {
      return this.state.pinnedPluginDock.includes(app.app_id) || Boolean(app.pinned_dock);
    }
    return Boolean(app.pinned_dock);
  }

  getOrderedDesktopApps() {
    const visible = this.state.shortcuts.filter((s) => this.isAppShownOnDesktop(s));
    const orderIndex = new Map(this.state.desktopOrder.map((id, idx) => [id, idx]));

    return [...visible].sort((a, b) => {
      const ia = orderIndex.has(a.app_id) ? orderIndex.get(a.app_id) : 10000 + (a.sort_order || 100);
      const ib = orderIndex.has(b.app_id) ? orderIndex.get(b.app_id) : 10000 + (b.sort_order || 100);
      return ia - ib;
    });
  }

  async loadShortcuts() {
    const data = await api.get('/api/system.php?action=shortcuts');
    this.state.shortcuts = data.shortcuts || [];
    this.renderDesktopIcons();
    this.renderDock();
  }

  renderDesktopIcons() {
    const desktopApps = this.getOrderedDesktopApps();

    this.els.iconsGrid.innerHTML = desktopApps.map((app) => {
      const title = getLocalizedAppTitle(app);
      const isExt = app.launch_mode === 'external' || app.open_mode === 'external' || app.open_mode === 'tab';
      const isRemote = app.open_mode === 'remote_browser';
      const modeBadge = isExt
        ? '<span style="position:absolute;top:3px;right:4px;font-size:10px;opacity:0.88;">↗</span>'
        : isRemote
          ? '<span style="position:absolute;top:3px;right:4px;font-size:9px;opacity:0.9;">🌐</span>'
          : '';
      return `
        <button type="button" class="desktop-icon-item" data-app-id="${this.escapeHtml(app.app_id)}">
          <span class="app-squircle" style="background:${this.escapeHtml(app.accent_color)}">
            ${renderAppVisualIcon(app)}
            ${modeBadge}
          </span>
          <span class="desktop-icon-label">${this.escapeHtml(title)}</span>
        </button>
      `;
    }).join('');

    this.bindDesktopIconInteractions();
  }

  /**
   * Pointer-based Drag & Drop reordering + Click to Open + Long-Press (500ms) Context Menu
   * Works seamlessly on both Desktop Mouse and Mobile/Tablet Touch!
   */
  bindDesktopIconInteractions() {
    const buttons = Array.from(this.els.iconsGrid.querySelectorAll('.desktop-icon-item'));

    buttons.forEach((btn) => {
      let startX = 0;
      let startY = 0;
      let isDragging = false;
      let longPressTimer = null;
      let suppressClick = false;
      let hoverTargetId = null;

      const clearLongPress = () => {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
      };

      btn.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        startX = e.clientX;
        startY = e.clientY;
        isDragging = false;
        suppressClick = false;
        hoverTargetId = null;

        // Touch / Mobile long-press >= 500ms opens icon context menu
        if (e.pointerType !== 'mouse') {
          longPressTimer = setTimeout(() => {
            if (!isDragging) {
              suppressClick = true;
              this.openContextMenu(e.clientX, e.clientY, btn.dataset.appId);
            }
          }, 520);
        }

        const onMove = (ev) => {
          const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
          if (!isDragging && dist > 9) {
            isDragging = true;
            suppressClick = true;
            clearLongPress();
            btn.classList.add('is-dragging');
          }
          if (!isDragging) return;

          buttons.forEach((b) => b.classList.remove('drag-over'));
          const elUnder = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.desktop-icon-item');
          if (elUnder && elUnder !== btn) {
            elUnder.classList.add('drag-over');
            hoverTargetId = elUnder.dataset.appId;
          } else {
            hoverTargetId = null;
          }
        };

        const onUp = async () => {
          clearLongPress();
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);

          btn.classList.remove('is-dragging');
          buttons.forEach((b) => b.classList.remove('drag-over'));

          if (isDragging && hoverTargetId && hoverTargetId !== btn.dataset.appId) {
            const orderedIds = this.getOrderedDesktopApps().map((a) => a.app_id);
            const fromIdx = orderedIds.indexOf(btn.dataset.appId);
            const toIdx = orderedIds.indexOf(hoverTargetId);
            if (fromIdx !== -1 && toIdx !== -1) {
              orderedIds.splice(fromIdx, 1);
              orderedIds.splice(toIdx, 0, btn.dataset.appId);
              this.state.desktopOrder = orderedIds;
              this.renderDesktopIcons();
              await this.saveDesktopLayout();
            }
          }
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      });

      btn.addEventListener('click', (e) => {
        if (suppressClick) {
          e.preventDefault();
          suppressClick = false;
          return;
        }
        this.launchAppById(btn.dataset.appId);
      });
    });
  }

  renderDock() {
    const pinned = this.state.shortcuts.filter((s) => this.isAppPinnedToDock(s));
    const openWins = Array.from(this.wm.windows.values());
    const pinnedIds = new Set(pinned.map((s) => s.app_id));

    const transient = openWins
      .filter((w) => !pinnedIds.has(w.appId))
      .map((w) => this.state.shortcuts.find((s) => s.app_id === w.appId) || w.appDef || {
        app_id: w.appId,
        title: w.title,
        icon: w.icon,
        icon_url: w.iconUrl,
        accent_color: w.accentColor,
      });

    const renderBtn = (app) => {
      const win = this.wm.findByAppId(app.app_id);
      const isRunning = Boolean(win);
      const isFocused = Boolean(win && !win.minimized && this.wm.focusedId === win.id);
      const title = getLocalizedAppTitle(app);

      return `
        <button type="button" class="dock-item ${isRunning ? 'is-running' : ''} ${isFocused ? 'is-focused' : ''}" data-dock-app="${this.escapeHtml(app.app_id)}">
          <span class="dock-tooltip">${this.escapeHtml(title)}</span>
          <span class="app-squircle" style="background:${this.escapeHtml(app.accent_color)}">${renderAppVisualIcon(app)}</span>
          <span class="dock-dot"></span>
        </button>
      `;
    };

    let html = pinned.map(renderBtn).join('');
    if (transient.length > 0) {
      html += `<div class="dock-divider"></div>` + transient.map(renderBtn).join('');
    }
    this.els.dock.innerHTML = html;

    // Bind click, right-click & long-press (>= 500ms) on Dock items
    this.els.dock.querySelectorAll('[data-dock-app]').forEach((btn) => {
      let pressTimer = null;
      let longTriggered = false;

      btn.addEventListener('pointerdown', (e) => {
        longTriggered = false;
        if (e.pointerType !== 'mouse') {
          pressTimer = setTimeout(() => {
            longTriggered = true;
            this.openDockContextMenu(e.clientX, e.clientY, btn.dataset.dockApp);
          }, 500);
        }
      });

      const clearPress = () => {
        if (pressTimer) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
      };
      btn.addEventListener('pointerup', clearPress);
      btn.addEventListener('pointercancel', clearPress);
      btn.addEventListener('pointerleave', clearPress);

      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openDockContextMenu(e.clientX, e.clientY, btn.dataset.dockApp);
      });

      btn.addEventListener('click', (e) => {
        if (longTriggered) {
          e.preventDefault();
          return;
        }
        const app = this.state.shortcuts.find((s) => s.app_id === btn.dataset.dockApp);
        if (app) this.wm.toggleFromDock(app);
      });
    });
  }

  openDockContextMenu(x, y, appId) {
    const app = this.state.shortcuts.find((s) => s.app_id === appId);
    const win = this.wm.findByAppId(appId);
    if (!app && !win) return;

    const title = app ? getLocalizedAppTitle(app) : win.title;
    let html = '';

    if (win) {
      html += `
        <button type="button" class="ctx-item" data-dctx="center">🎯 ${this.escapeHtml(t('context.center_window'))}</button>
        <button type="button" class="ctx-item danger" data-dctx="close">✕ ${this.escapeHtml(t('context.close_window'))}</button>
      `;
    } else if (app) {
      html += `<button type="button" class="ctx-item" data-dctx="open">${this.escapeHtml(t('context.open_app', { title }))}</button>`;
    }

    this.els.contextMenu.innerHTML = html;
    this.els.contextMenu.classList.remove('hidden');

    const menuW = 210;
    const menuH = this.els.contextMenu.offsetHeight || 100;
    this.els.contextMenu.style.left = `${Math.max(8, Math.min(x - 60, window.innerWidth - menuW - 8))}px`;
    this.els.contextMenu.style.top = `${Math.max(8, y - menuH - 12)}px`;

    this.els.contextMenu.querySelectorAll('[data-dctx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.els.contextMenu.classList.add('hidden');
        const act = btn.dataset.dctx;
        if (act === 'center' && win) {
          this.wm.centerWindow(win.id);
        } else if (act === 'close' && win) {
          this.wm.close(win.id);
        } else if (act === 'open' && app) {
          this.launchAppById(app.app_id);
        }
      });
    });
  }

  onWindowsStateChanged({ activeWindow, windows }) {
    this.els.activeAppTitle.textContent = activeWindow ? activeWindow.title : t('topbar.desktop');
    this.els.closeAllBtn?.classList.toggle('hidden', windows.length === 0);
    this.renderDock();
  }

  launchAppById(appId, launchParams = {}) {
    const app = this.state.shortcuts.find((s) => s.app_id === appId);
    if (app) {
      this.wm.open(app, launchParams);
    }
  }

  async removeAppFromDesktop(appId) {
    const app = this.state.shortcuts.find((s) => s.app_id === appId);
    if (!app) return;
    if (!this.state.hiddenDesktopApps.includes(appId)) {
      this.state.hiddenDesktopApps.push(appId);
    }
    this.renderDesktopIcons();
    await this.saveDesktopLayout();
    this.toast(t('context.removed_toast', { title: getLocalizedAppTitle(app) }));
  }

  async addAppToDesktop(appId) {
    const app = this.state.shortcuts.find((s) => s.app_id === appId);
    if (!app) return;
    this.state.hiddenDesktopApps = this.state.hiddenDesktopApps.filter((id) => id !== appId);
    app.pinned_desktop = true;
    if (!this.state.desktopOrder.includes(appId)) {
      this.state.desktopOrder.push(appId);
    }
    this.renderDesktopIcons();
    await this.saveDesktopLayout();
    this.toast(t('context.added_toast', { title: getLocalizedAppTitle(app) }));
  }

  openAddAppModal() {
    const hiddenApps = this.state.shortcuts.filter((s) => !this.isAppShownOnDesktop(s));

    this.els.desktopModalLayer.classList.remove('hidden');
    this.els.desktopModalLayer.innerHTML = `
      <div class="spotlight-modal" style="max-width:520px;">
        <div class="drawer-header">
          <strong>${this.escapeHtml(t('context.add_modal_title'))}</strong>
          <div style="display:flex;gap:8px;">
            <button type="button" class="btn-xs primary" id="openNewWebShortcutFromAddBtn">${this.escapeHtml(t('shortcuts.spotlight_create'))}</button>
            <button type="button" class="btn-xs" id="closeAddAppModalBtn">${this.escapeHtml(t('common.close'))}</button>
          </div>
        </div>
        <div class="spotlight-results" style="padding:12px;">
          ${hiddenApps.length === 0
            ? `<div style="padding:18px;text-align:center;color:var(--os-text-secondary);">${this.escapeHtml(t('context.add_modal_empty'))}</div>`
            : hiddenApps.map((app) => `
              <div class="spotlight-item" style="cursor:default;">
                <div style="display:flex;align-items:center;gap:12px;">
                  <span class="win-app-badge" style="width:34px;height:34px;border-radius:10px;background:${this.escapeHtml(app.accent_color)}">
                    ${renderAppVisualIcon(app)}
                  </span>
                  <div>
                    <div style="font-weight:600;font-size:0.88rem;">${this.escapeHtml(getLocalizedAppTitle(app))}</div>
                    <div style="font-size:0.75rem;color:var(--os-text-secondary);">${this.escapeHtml(getLocalizedAppSubtitle(app))}</div>
                  </div>
                </div>
                <button type="button" class="btn-xs primary" data-restore-app="${this.escapeHtml(app.app_id)}">${this.escapeHtml(t('context.add_btn'))}</button>
              </div>
            `).join('')
          }
        </div>
      </div>
    `;

    this.els.desktopModalLayer.querySelector('#closeAddAppModalBtn').addEventListener('click', () => {
      this.els.desktopModalLayer.classList.add('hidden');
    });

    this.els.desktopModalLayer.querySelector('#openNewWebShortcutFromAddBtn').addEventListener('click', () => {
      this.openWebShortcutModal(null);
    });

    this.els.desktopModalLayer.querySelectorAll('[data-restore-app]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await this.addAppToDesktop(btn.dataset.restoreApp);
        this.openAddAppModal();
      });
    });
  }

  /**
   * Opens the Web Shortcut Creator / Editor Modal (`external`, `window`, `remote_browser`).
   */
  openWebShortcutModal(existingApp = null) {
    const isEdit = Boolean(existingApp && existingApp.id && existingApp.app_type === 'shortcut');
    const iconChoices = [
      'globe', 'server', 'harddrive', 'camera', 'home', 'file-code',
      'activity', 'shield', 'database', 'play', 'sparkles', 'link',
    ];
    const colorChoices = [
      '#0EA5E9', '#FF6D5A', '#10B981', '#8B5CF6',
      '#F59E0B', '#EC4899', '#3B82F6', '#64748B',
    ];

    let selectedIcon = existingApp?.icon || 'globe';
    let selectedColor = existingApp?.accent_color || '#0EA5E9';
    const currentUrl = existingApp?.url || existingApp?.target_url || '';
    const currentMode = existingApp?.open_mode || 'remote_browser';
    const hasFavicon = Boolean(existingApp?.icon_url);

    this.els.desktopModalLayer.classList.remove('hidden');
    this.els.desktopModalLayer.innerHTML = `
      <div class="spotlight-modal" style="max-width:520px;">
        <div class="drawer-header">
          <strong>🔗 ${this.escapeHtml(t(isEdit ? 'shortcuts.modal_edit_title' : 'shortcuts.modal_create_title'))}</strong>
          <button type="button" class="btn-xs" id="closeWebShortcutModalBtn">${this.escapeHtml(t('common.close'))}</button>
        </div>

        <form id="webShortcutForm" style="padding:16px 18px;display:flex;flex-direction:column;gap:12px;max-height:78vh;overflow-y:auto;">
          <div id="webShortcutErr" class="os-alert os-alert-error hidden" style="margin-bottom:0;"></div>

          <div>
            <label class="form-label">${this.escapeHtml(t('shortcuts.name_label'))}</label>
            <input type="text" class="os-input" name="title" value="${this.escapeHtml(existingApp?.title || '')}" placeholder="${this.escapeHtml(t('shortcuts.name_ph'))}" maxlength="48" required autofocus>
          </div>

          <div>
            <label class="form-label">${this.escapeHtml(t('shortcuts.url_label'))}</label>
            <input type="url" class="os-input" name="url" value="${this.escapeHtml(currentUrl)}" placeholder="${this.escapeHtml(t('shortcuts.url_ph'))}" required style="font-family:var(--font-mono);font-size:0.84rem;">
          </div>

          <div>
            <label class="form-label">${this.escapeHtml(t('shortcuts.mode_label'))}</label>
            <select class="os-select" name="open_mode">
              <option value="remote_browser" ${currentMode === 'remote_browser' ? 'selected' : ''}>🌐 ${this.escapeHtml(t('shortcuts.mode_remote'))}</option>
              <option value="external" ${currentMode === 'external' ? 'selected' : ''}>↗ ${this.escapeHtml(t('shortcuts.mode_external'))}</option>
              <option value="window" ${currentMode === 'window' ? 'selected' : ''}>🗔 ${this.escapeHtml(t('shortcuts.mode_window'))}</option>
            </select>
          </div>

          <div>
            <label class="form-label">${this.escapeHtml(t('shortcuts.icon_label'))}</label>
            <div id="scIconPickerGrid" style="display:grid;grid-template-columns:repeat(6,1fr);gap:8px;">
              ${iconChoices.map((ic) => `
                <button type="button" class="btn-xs ${ic === selectedIcon ? 'primary' : ''}" data-pick-sc-icon="${ic}" style="justify-content:center;height:38px;">
                  <span style="width:20px;height:20px;display:inline-flex;">${getAppIconSvg(ic)}</span>
                </button>
              `).join('')}
            </div>
          </div>

          <div>
            <label class="form-label">${this.escapeHtml(t('shortcuts.color_label'))}</label>
            <div id="scColorPickerRow" style="display:flex;gap:8px;flex-wrap:wrap;">
              ${colorChoices.map((col) => `
                <button type="button" data-pick-sc-color="${col}" style="width:28px;height:28px;border-radius:9px;background:${col};border:2px solid ${col.toUpperCase() === selectedColor.toUpperCase() ? '#FFFFFF' : 'transparent'};box-shadow:0 2px 8px rgba(0,0,0,0.3);"></button>
              `).join('')}
            </div>
          </div>

          <div style="display:flex;flex-direction:column;gap:7px;font-size:0.82rem;">
            <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;">
              <input type="checkbox" name="use_favicon" ${hasFavicon ? 'checked' : ''}>
              ${this.escapeHtml(t('shortcuts.use_favicon'))}
            </label>
            ${!isEdit ? `
              <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;">
                <input type="checkbox" name="pinned_dock">
                ${this.escapeHtml(t('shortcuts.pin_dock'))}
              </label>
            ` : ''}
          </div>

          <button type="submit" class="os-btn os-btn-primary" style="margin-top:4px;">💾 ${this.escapeHtml(t('shortcuts.save_btn'))}</button>
        </form>
      </div>
    `;

    const modal = this.els.desktopModalLayer;
    const errBox = modal.querySelector('#webShortcutErr');

    modal.querySelector('#closeWebShortcutModalBtn').addEventListener('click', () => {
      modal.classList.add('hidden');
    });

    modal.querySelectorAll('[data-pick-sc-icon]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedIcon = btn.dataset.pickScIcon;
        modal.querySelectorAll('[data-pick-sc-icon]').forEach((b) => b.classList.toggle('primary', b === btn));
      });
    });

    modal.querySelectorAll('[data-pick-sc-color]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedColor = btn.dataset.pickScColor;
        modal.querySelectorAll('[data-pick-sc-color]').forEach((b) => {
          b.style.borderColor = b === btn ? '#FFFFFF' : 'transparent';
        });
      });
    });

    modal.querySelector('#webShortcutForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      errBox.classList.add('hidden');
      const fd = new FormData(e.currentTarget);
      const rawUrl = String(fd.get('url') || '').trim();

      if (!/^https?:\/\/.+/i.test(rawUrl)) {
        errBox.textContent = 'Only http:// and https:// URLs are allowed.';
        errBox.classList.remove('hidden');
        return;
      }

      try {
        const res = await api.post('/api/shortcuts.php?action=save', {
          id: isEdit ? existingApp.id : 0,
          title: fd.get('title'),
          url: rawUrl,
          open_mode: fd.get('open_mode'),
          icon: selectedIcon,
          accent_color: selectedColor,
          use_favicon: fd.get('use_favicon') === 'on',
          pinned_dock: fd.get('pinned_dock') === 'on',
        });

        if (!isEdit && res.app_id) {
          this.state.hiddenDesktopApps = this.state.hiddenDesktopApps.filter((id) => id !== res.app_id);
          if (!this.state.desktopOrder.includes(res.app_id)) {
            this.state.desktopOrder.push(res.app_id);
          }
          await this.saveDesktopLayout();
        }

        modal.classList.add('hidden');
        await this.loadShortcuts();
        this.toast(t('shortcuts.saved_toast'));
      } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
      }
    });
  }

  // ==========================================================================
  // 5. LIVE TELEMETRY (CPU / RAM / NOTIFICATIONS / CLOCK)
  // ==========================================================================

  startClock() {
    const tick = () => {
      const now = new Date();
      const locale = getLocaleTag();
      const str = now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
      const day = now.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
      if (this.els.clockText) {
        this.els.clockText.textContent = `${day}  ${str}`;
      }
      const lockDigits = document.getElementById('lockClockDigits');
      if (lockDigits) {
        lockDigits.textContent = str;
      }
    };
    tick();
    this.state.clockTimer = setInterval(tick, 10000);
  }

  startPulse() {
    this.stopPulse();
    this.fetchPulse();
    const interval = Math.max(2000, Number(this.state.os.metrics_interval) || 3000);
    this.state.pulseTimer = setInterval(() => {
      if (!this.state.locked && !document.hidden) {
        this.fetchPulse();
      }
    }, interval);
  }

  stopPulse() {
    if (this.state.pulseTimer) {
      clearInterval(this.state.pulseTimer);
      this.state.pulseTimer = null;
    }
  }

  async fetchPulse() {
    try {
      const data = await api.get('/api/system.php?action=pulse');
      const cpu = Number(data.metrics?.cpu?.total_percent || 0);
      const ram = Number(data.metrics?.memory?.used_percent || 0);

      this.els.cpuText.textContent = `${cpu.toFixed(0)}%`;
      this.els.cpuBar.style.width = `${Math.min(100, cpu)}%`;
      this.els.cpuBar.style.backgroundColor = cpu > 85 ? 'var(--os-danger)' : cpu > 65 ? 'var(--os-warning)' : 'var(--os-success)';

      this.els.ramText.textContent = `${ram.toFixed(0)}%`;
      this.els.ramBar.style.width = `${Math.min(100, ram)}%`;
      this.els.ramBar.style.backgroundColor = ram > 85 ? 'var(--os-danger)' : ram > 70 ? 'var(--os-warning)' : 'var(--os-info)';

      if (this.els.mobileHero) {
        this.els.mobileHero.innerHTML = `
          <div>
            <div style="font-size:0.74rem;color:var(--os-text-secondary);">${this.escapeHtml(t('mobile.debian_server'))}</div>
            <div style="font-weight:700;font-size:0.98rem;">${this.escapeHtml(data.hostname || 'debian')}</div>
          </div>
          <div style="text-align:right;font-family:var(--font-mono);font-size:0.8rem;">
            <div>CPU <strong style="color:var(--os-success)">${cpu.toFixed(0)}%</strong></div>
            <div>RAM <strong style="color:var(--os-info)">${ram.toFixed(0)}%</strong></div>
          </div>
        `;
      }

      const unread = Number(data.unread_notifications || 0);
      this.updateBellBadge(unread);
    } catch (_) {}
  }

  updateBellBadge(count) {
    const unread = Math.max(0, Number(count) || 0);
    if (unread > 0) {
      this.els.notifBadge.textContent = unread > 99 ? '99+' : String(unread);
      this.els.notifBadge.classList.remove('hidden');
    } else {
      this.els.notifBadge.classList.add('hidden');
    }
  }

  syncNotificationsNow() {
    if (!this.state.authenticated || this.state.locked) return;
    if (this._notifSyncTimer) clearTimeout(this._notifSyncTimer);
    this._notifSyncTimer = setTimeout(async () => {
      try {
        const res = await api.get('/api/notifications.php?action=list');
        this.updateBellBadge(res.unread_count || 0);
        if (!this.els.notifDrawer.classList.contains('hidden')) {
          this.renderNotificationItems(res.notifications || []);
        }
      } catch (_) {}
    }, 150);
  }

  formatRelativeTime(utcDateTimeStr) {
    if (!utcDateTimeStr) return '';
    const iso = String(utcDateTimeStr).includes('T')
      ? String(utcDateTimeStr)
      : String(utcDateTimeStr).replace(' ', 'T') + 'Z';
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return String(utcDateTimeStr);

    const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (diffSec < 45) return t('notifications.just_now');
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return t('notifications.min_ago', { n: diffMin });
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return t('notifications.hour_ago', { n: diffHr });
    const diffDay = Math.floor(diffHr / 24);
    return t('notifications.day_ago', { n: diffDay });
  }

  normalizeActionUrl(rawUrl) {
    if (!rawUrl) return '';
    const str = String(rawUrl).trim();
    const shareMatch = str.match(/\/share\.php\?t=([a-f0-9]+)/i);
    if (shareMatch) {
      return `${window.location.origin}/share.php?t=${encodeURIComponent(shareMatch[1])}`;
    }
    return str;
  }

  // ==========================================================================
  // 6. SPOTLIGHT (CTRL+K), NOTIFICATIONS & DESKTOP CONTEXT MENU
  // ==========================================================================

  toggleSpotlight() {
    const isHidden = this.els.spotlightBackdrop.classList.contains('hidden');
    this.closeFloatingPanels();
    if (isHidden) {
      this.els.spotlightBackdrop.classList.remove('hidden');
      this.els.spotlightInput.value = '';
      this.renderSpotlightItems('');
      setTimeout(() => this.els.spotlightInput.focus(), 20);
    }
  }

  renderSpotlightItems(query) {
    const q = query.trim().toLowerCase();
    const matches = this.state.shortcuts.filter((s) => {
      const title = getLocalizedAppTitle(s).toLowerCase();
      const sub = getLocalizedAppSubtitle(s).toLowerCase();
      return q === '' || title.includes(q) || sub.includes(q) || s.app_id.toLowerCase().includes(q);
    });

    const createActionMatch = q === '' ||
      t('shortcuts.spotlight_create').toLowerCase().includes(q) ||
      'shortcut'.includes(q) ||
      'url'.includes(q);

    const createRowHtml = createActionMatch ? `
      <div class="spotlight-item" style="padding:8px 12px;border-bottom:1px solid var(--os-border);margin-bottom:4px;">
        <button type="button" id="spotNewShortcutBtn" style="display:flex;align-items:center;gap:12px;flex:1;text-align:left;">
          <span class="win-app-badge" style="width:32px;height:32px;border-radius:9px;background:var(--os-accent)">
            ${getAppIconSvg('link')}
          </span>
          <div>
            <div style="font-weight:600;font-size:0.88rem;color:var(--os-accent);">${this.escapeHtml(t('shortcuts.spotlight_create'))}</div>
            <div style="font-size:0.75rem;color:var(--os-text-secondary);">${this.escapeHtml(t('shortcuts.spotlight_create_sub'))}</div>
          </div>
        </button>
      </div>
    ` : '';

    this.els.spotlightResults.innerHTML = createRowHtml + (matches.map((app, i) => {
      const onDesktop = this.isAppShownOnDesktop(app);
      const isExt = app.launch_mode === 'external' || app.open_mode === 'external' || app.open_mode === 'tab';
      const isRemote = app.open_mode === 'remote_browser';
      return `
        <div class="spotlight-item ${i === 0 ? 'is-selected' : ''}" style="padding:8px 12px;">
          <button type="button" data-spot-open="${this.escapeHtml(app.app_id)}" style="display:flex;align-items:center;gap:12px;flex:1;min-width:0;text-align:left;">
            <span class="win-app-badge" style="width:32px;height:32px;border-radius:9px;background:${this.escapeHtml(app.accent_color)}">
              ${renderAppVisualIcon(app)}
            </span>
            <div style="min-width:0;">
              <div style="font-weight:600;font-size:0.88rem;">
                ${this.escapeHtml(getLocalizedAppTitle(app))} ${isExt ? '↗' : isRemote ? '🌐' : ''}
              </div>
              <div style="font-size:0.76rem;color:var(--os-text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                ${this.escapeHtml(getLocalizedAppSubtitle(app))}
              </div>
            </div>
          </button>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
            ${!onDesktop ? `<button type="button" class="btn-xs" data-spot-add="${this.escapeHtml(app.app_id)}">${this.escapeHtml(t('spotlight.add_to_desktop'))}</button>` : ''}
            <span style="font-size:0.74rem;color:var(--os-text-muted);">${this.escapeHtml(t('spotlight.open_enter'))}</span>
          </div>
        </div>
      `;
    }).join('') || `<div style="padding:18px;text-align:center;color:var(--os-text-secondary);">${this.escapeHtml(t('spotlight.no_results'))}</div>`);

    this.els.spotlightResults.querySelector('#spotNewShortcutBtn')?.addEventListener('click', () => {
      this.els.spotlightBackdrop.classList.add('hidden');
      this.openWebShortcutModal(null);
    });

    this.els.spotlightResults.querySelectorAll('[data-spot-open]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.els.spotlightBackdrop.classList.add('hidden');
        this.launchAppById(btn.dataset.spotOpen);
      });
    });

    this.els.spotlightResults.querySelectorAll('[data-spot-add]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.addAppToDesktop(btn.dataset.spotAdd);
        this.renderSpotlightItems(this.els.spotlightInput.value);
      });
    });
  }

  async toggleNotificationsDrawer() {
    const willOpen = this.els.notifDrawer.classList.contains('hidden');
    this.closeFloatingPanels();
    if (willOpen) {
      this.els.notifDrawer.classList.remove('hidden');
      await this.loadNotifications();
    }
  }

  async loadNotifications() {
    const res = await api.get('/api/notifications.php?action=list');
    this.updateBellBadge(res.unread_count || 0);
    this.renderNotificationItems(res.notifications || []);
  }

  renderNotificationItems(items) {
    if (!items || items.length === 0) {
      this.els.notifList.innerHTML = `<div style="padding:24px;text-align:center;color:var(--os-text-secondary);font-size:0.84rem;">${this.escapeHtml(t('notifications.empty'))}</div>`;
      return;
    }

    const levelMeta = {
      success: { icon: '✅', border: 'var(--os-success)', pill: 'status-running' },
      warning: { icon: '⚠️', border: 'var(--os-warning)', pill: 'status-stopped' },
      error: { icon: '🚨', border: 'var(--os-danger)', pill: 'status-error' },
      info: { icon: 'ℹ️', border: 'var(--os-accent)', pill: 'status-info' },
    };

    this.els.notifList.innerHTML = items.map((n) => {
      const meta = levelMeta[n.level] || levelMeta.info;
      const isUnread = Number(n.is_read) === 0;
      const actionUrl = this.normalizeActionUrl(n.action_url);
      const isShareLink = actionUrl.includes('/share.php?t=') || n.action_label === 'Copy Link';

      let actionsHtml = '';
      if (actionUrl) {
        actionsHtml = `
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
            ${isShareLink ? `<button type="button" class="btn-xs primary" data-notif-copy="${this.escapeHtml(actionUrl)}" data-notif-id="${n.id}">📋 ${this.escapeHtml(t('shares.copy_link'))}</button>` : ''}
            <a href="${this.escapeHtml(actionUrl)}" target="_blank" rel="noopener noreferrer" class="btn-xs ${isShareLink ? '' : 'primary'}" data-notif-open-id="${n.id}" style="text-decoration:none;">↗ ${this.escapeHtml(isShareLink ? t('common.open') : (n.action_label || t('common.open')))}</a>
          </div>
        `;
      }

      return `
        <div class="notif-card" data-notif-id="${n.id}" data-notif-payload="${this.escapeHtml(n.action_payload_json || '')}" style="cursor:${n.action_payload_json ? 'pointer' : 'default'};border-left:3px solid ${meta.border};opacity:${isUnread ? '1' : '0.82'};">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px;">
            <div style="font-weight:600;font-size:0.84rem;display:flex;align-items:center;gap:6px;">
              <span>${meta.icon}</span>
              <span>${this.escapeHtml(n.title)}</span>
              ${isUnread ? '<span data-unread-dot="1" style="width:7px;height:7px;border-radius:50%;background:var(--os-accent);display:inline-block;flex-shrink:0;"></span>' : ''}
            </div>
            <span class="status-pill-sm ${meta.pill}" style="font-size:0.65rem;padding:1px 7px;text-transform:uppercase;">${this.escapeHtml(n.level || 'info')}</span>
          </div>
          ${n.message ? `<div style="font-size:0.79rem;color:var(--os-text-secondary);margin-bottom:6px;word-break:break-word;">${this.escapeHtml(n.message)}</div>` : ''}
          ${actionsHtml}
          <div style="font-size:0.7rem;color:var(--os-text-muted);font-family:var(--font-mono);margin-top:6px;" title="${this.escapeHtml(n.created_at)}">${this.escapeHtml(this.formatRelativeTime(n.created_at))}</div>
        </div>
      `;
    }).join('');

    const markSingleRead = async (id) => {
      if (!id) return;
      const cardEl = this.els.notifList.querySelector(`.notif-card[data-notif-id="${id}"]`);
      if (cardEl) {
        cardEl.querySelector('[data-unread-dot]')?.remove();
        cardEl.style.opacity = '0.82';
      }
      try {
        const r = await api.post('/api/notifications.php?action=read', { id: Number(id) });
        this.updateBellBadge(r.unread_count || 0);
      } catch (_) {}
    };

    this.els.notifList.querySelectorAll('[data-notif-copy]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await navigator.clipboard.writeText(btn.dataset.notifCopy);
        btn.textContent = `✓ ${t('common.copied')}`;
        setTimeout(() => { btn.textContent = `📋 ${t('shares.copy_link')}`; }, 1500);
        await markSingleRead(btn.dataset.notifId);
      });
    });

    this.els.notifList.querySelectorAll('[data-notif-open-id]').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.stopPropagation();
        markSingleRead(link.dataset.notifOpenId);
      });
    });

    this.els.notifList.querySelectorAll('[data-notif-payload]').forEach((card) => {
      card.addEventListener('click', async () => {
        await markSingleRead(card.dataset.notifId);
        if (!card.dataset.notifPayload) return;
        try {
          const payload = JSON.parse(card.dataset.notifPayload);
          if (payload.app) {
            this.els.notifDrawer.classList.add('hidden');
            this.launchAppById(payload.app, payload);
          }
        } catch (_) {}
      });
    });
  }

  openContextMenu(x, y, appId) {
    const app = appId ? this.state.shortcuts.find((s) => s.app_id === appId) : null;
    let html = '';

    if (app) {
      const title = getLocalizedAppTitle(app);
      const pinnedDock = this.isAppPinnedToDock(app);
      const isUserShortcut = app.app_type === 'shortcut';
      html = `
        <button type="button" class="ctx-item" data-ctx="open">${this.escapeHtml(t('context.open_app', { title }))}</button>
        ${isUserShortcut ? `<button type="button" class="ctx-item" data-ctx="edit-shortcut">✎ ${this.escapeHtml(t('shortcuts.edit_menu'))}</button>` : ''}
        <button type="button" class="ctx-item" data-ctx="toggle-dock">${this.escapeHtml(pinnedDock ? t('context.unpin_dock') : t('context.pin_dock'))}</button>
        <button type="button" class="ctx-item" data-ctx="remove-desktop">${this.escapeHtml(t('context.remove_desktop'))}</button>
        ${isUserShortcut ? `<button type="button" class="ctx-item danger" data-ctx="delete-shortcut">✕ ${this.escapeHtml(t('shortcuts.delete_menu'))}</button>` : ''}
        <div class="ctx-sep"></div>
      `;
    }

    html += `
      <button type="button" class="ctx-item" data-ctx="new-shortcut">🔗 ${this.escapeHtml(t('shortcuts.new_menu'))}</button>
      <button type="button" class="ctx-item" data-ctx="add-desktop">+ ${this.escapeHtml(t('context.add_app_desktop'))}</button>
      <button type="button" class="ctx-item" data-ctx="spotlight">${this.escapeHtml(t('context.spotlight'))}</button>
      <button type="button" class="ctx-item" data-ctx="appearance">${this.escapeHtml(t('context.appearance'))}</button>
      ${this.wm.windows.size > 0 ? `<button type="button" class="ctx-item" data-ctx="close-all">✕ ${this.escapeHtml(t('context.close_all'))}</button>` : ''}
      <button type="button" class="ctx-item" data-ctx="refresh">${this.escapeHtml(t('context.refresh'))}</button>
      <div class="ctx-sep"></div>
      <button type="button" class="ctx-item" data-ctx="lock">${this.escapeHtml(t('context.lock'))}</button>
    `;

    this.els.contextMenu.innerHTML = html;
    this.els.contextMenu.classList.remove('hidden');

    const menuW = 240;
    const menuH = this.els.contextMenu.offsetHeight || 240;
    this.els.contextMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menuW - 8))}px`;
    this.els.contextMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menuH - 8))}px`;

    this.els.contextMenu.querySelectorAll('[data-ctx]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        this.els.contextMenu.classList.add('hidden');
        const act = btn.dataset.ctx;
        if (act === 'open' && app) {
          this.launchAppById(app.app_id);
        } else if (act === 'new-shortcut') {
          this.openWebShortcutModal(null);
        } else if (act === 'edit-shortcut' && app) {
          this.openWebShortcutModal(app);
        } else if (act === 'delete-shortcut' && app) {
          if (window.confirm(t('shortcuts.confirm_delete', { title: getLocalizedAppTitle(app) }))) {
            try {
              await api.delete('/api/shortcuts.php', { id: app.id, app_id: app.app_id });
              await this.loadShortcuts();
              this.toast(t('shortcuts.deleted_toast'));
            } catch (err) {
              this.toast(err.message, 'error');
            }
          }
        } else if (act === 'toggle-dock' && app) {
          if (app.app_type === 'plugin') {
            const exists = this.state.pinnedPluginDock.includes(app.app_id);
            this.state.pinnedPluginDock = exists
              ? this.state.pinnedPluginDock.filter((id) => id !== app.app_id)
              : [...this.state.pinnedPluginDock, app.app_id];
            await this.saveDesktopLayout();
            this.renderDock();
          } else {
            await api.post('/api/system.php?action=shortcut_toggle_dock', {
              app_id: app.app_id,
              pinned_dock: !app.pinned_dock,
            });
            await this.loadShortcuts();
          }
        } else if (act === 'remove-desktop' && app) {
          await this.removeAppFromDesktop(app.app_id);
        } else if (act === 'add-desktop') {
          this.openAddAppModal();
        } else if (act === 'spotlight') {
          this.toggleSpotlight();
        } else if (act === 'appearance') {
          this.launchAppById('system-settings', { section: 'security' });
        } else if (act === 'close-all') {
          this.wm.closeAllAndResetPositions();
          this.toast(t('window.all_closed_toast'));
        } else if (act === 'refresh') {
          await this.loadShortcuts();
          await this.fetchPulse();
        } else if (act === 'lock') {
          await api.post('/api/auth.php?action=lock');
          this.state.locked = true;
          this.showLockScreen();
        }
      });
    });
  }

  /**
   * Unified notification dispatcher: shows floating toast and either persists
   * to SQLite (`persist: true`) or immediately syncs the Bell badge & drawer.
   */
  notify(message, optionsOrType = 'info') {
    const opts = typeof optionsOrType === 'string'
      ? { level: optionsOrType }
      : (optionsOrType || {});

    const level = opts.level || opts.type || 'info';
    const title = opts.title || '';
    const borderColors = {
      success: 'var(--os-success)',
      warning: 'var(--os-warning)',
      error: 'var(--os-danger)',
      info: 'var(--os-accent)',
    };

    const el = document.createElement('div');
    el.className = 'os-toast';
    el.style.borderLeft = `4px solid ${borderColors[level] || 'var(--os-accent)'}`;
    if (title) {
      el.innerHTML = `<div style="font-weight:700;margin-bottom:2px;">${this.escapeHtml(title)}</div><div>${this.escapeHtml(message)}</div>`;
    } else {
      el.textContent = message;
    }
    this.els.toastStack.appendChild(el);
    setTimeout(() => el.remove(), 4500);

    if (opts.persist && this.state.authenticated && !this.state.locked) {
      api.post('/api/notifications.php?action=create', {
        level,
        title: title || message,
        message: title ? message : '',
        action_url: opts.actionUrl || null,
        action_label: opts.actionLabel || null,
        action_payload: opts.actionPayload || null,
        source: opts.source || 'ui',
      }).then((res) => {
        this.updateBellBadge(res.unread_count || 0);
        if (!this.els.notifDrawer.classList.contains('hidden') && Array.isArray(res.notifications)) {
          this.renderNotificationItems(res.notifications);
        }
      }).catch(() => {});
    } else {
      this.syncNotificationsNow();
    }
  }

  toast(message, optionsOrType = 'info') {
    this.notify(message, optionsOrType);
  }

  escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const desktop = new VanillIADesktop();
  window.__VANILLIA_DESKTOP__ = desktop;
  window.VanillIA = {
    notify: (message, options) => desktop.notify(message, options),
    desktop,
  };
  desktop.init();
});
