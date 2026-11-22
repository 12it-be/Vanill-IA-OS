<?php

declare(strict_types=1);

require_once __DIR__ . '/api/bootstrap.php';

vanillia_start_session(false);
$csrfToken = vanillia_csrf_token();
$osName = vanillia_get_setting('os.name', 'Vanill-IA OS');

header('X-Frame-Options: SAMEORIGIN');
header('X-Content-Type-Options: nosniff');
?>
<!DOCTYPE html>
<html lang="en" data-theme="dark" data-wallpaper="aurora-coral">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <meta name="csrf-token" content="<?= htmlspecialchars($csrfToken, ENT_QUOTES, 'UTF-8') ?>">
  <meta name="theme-color" content="#0F1115">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Vanill-IA OS">
  <meta name="application-name" content="Vanill-IA OS">

  <title><?= htmlspecialchars($osName, ENT_QUOTES, 'UTF-8') ?></title>

  <link rel="manifest" href="/manifest.json">
  <link rel="icon" type="image/svg+xml" href="/assets/img/icons/logo.svg">
  <link rel="icon" type="image/png" sizes="32x32" href="/assets/img/pwa/favicon-32.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/assets/img/pwa/apple-touch-icon.png">
  <link rel="stylesheet" href="/assets/css/desktop.css">
</head>
<body>
  <!-- GPU Mesh Wallpaper -->
  <div class="os-wallpaper" aria-hidden="true"></div>

  <!-- Setup Wizard / Sign In Layer -->
  <main id="authLayer" class="auth-layer hidden"></main>

  <!-- Session Lock Overlay (preserves open windows underneath) -->
  <aside id="lockLayer" class="lock-layer hidden"></aside>

  <!-- System Topbar -->
  <header id="osTopbar" class="os-topbar hidden">
    <div class="topbar-left">
      <button type="button" id="launcherMenuBtn" class="topbar-btn" data-i18n-title="topbar.apps_menu_title" title="Applications Menu (Ctrl+K)">
        <img src="/assets/img/icons/logo.svg" alt="Vanill-IA" class="topbar-logo">
        <strong>Vanill-IA OS</strong>
      </button>
      <span id="activeAppTitle" class="topbar-active-app hide-mobile" data-i18n="topbar.desktop">Desktop</span>
    </div>

    <button type="button" id="spotlightTriggerBtn" class="topbar-spotlight-trigger hide-mobile">
      <span data-i18n="topbar.search_placeholder">Search an app or action...</span>
      <kbd>Ctrl K</kbd>
    </button>

    <div class="topbar-right">
      <button type="button" id="closeAllWindowsBtn" class="topbar-btn topbar-close-all hidden" data-i18n-title="topbar.close_all_title" title="Close all open windows and reset window positions">
        <span>✕</span>
        <span class="hide-mobile" data-i18n="topbar.close_all">Close All</span>
      </button>

      <button type="button" id="pwaInstallBtn" class="topbar-btn hidden" data-i18n-title="topbar.install_pwa_title" title="Install PWA Application">
        <span style="color:var(--os-accent);font-weight:700;" data-i18n="topbar.install_pwa">+ Install App</span>
      </button>

      <button type="button" id="topbarMetricsBtn" class="topbar-btn hide-mobile" style="padding:0 4px;" data-i18n-title="topbar.metrics_title" title="Open Resource Monitor">
        <span class="metric-pill">
          <span>CPU</span>
          <span class="metric-bar"><span id="topbarCpuBar" style="width:0%"></span></span>
          <span id="topbarCpuText">--%</span>
        </span>
        <span class="metric-pill">
          <span>RAM</span>
          <span class="metric-bar"><span id="topbarRamBar" style="width:0%"></span></span>
          <span id="topbarRamText">--%</span>
        </span>
      </button>

      <button type="button" id="themeSwitchBtn" class="topbar-btn" data-i18n-title="topbar.theme_toggle_title" title="Toggle Dark / Light Mode">◐</button>

      <button type="button" id="notifToggleBtn" class="topbar-btn" data-i18n-title="topbar.notifications_title" title="Notification Center">
        <span>🔔</span>
        <span id="notifBadge" class="notif-badge hidden">0</span>
      </button>

      <span id="topbarClock" class="topbar-btn hide-mobile" style="cursor:default;font-variant-numeric:tabular-nums;">--:--</span>

      <button type="button" id="powerMenuBtn" class="topbar-btn" data-i18n-title="topbar.power_title" title="Session, Lock &amp; Power" aria-label="Power Menu">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path>
          <line x1="12" y1="2" x2="12" y2="12"></line>
        </svg>
      </button>
    </div>
  </header>

  <!-- Desktop Workspace & Multi-Window Layer -->
  <div id="osDesktop" class="os-desktop hidden">
    <div id="mobileHeroCard" class="mobile-hero-card"></div>
    <div id="desktopIconsGrid" class="desktop-icons-grid"></div>
    <div id="windowsLayer" class="windows-layer"></div>
  </div>

  <!-- Edge-Snap Magnetic Preview -->
  <div id="snapPreview" class="snap-preview hidden"></div>

  <!-- Floating Bottom Dock -->
  <nav id="osDockWrap" class="os-dock-wrap hidden" aria-label="Applications Dock">
    <div id="osDock" class="os-dock"></div>
  </nav>

  <!-- Mobile App Launcher Bottom Navigation (< 860px) -->
  <nav id="mobileTaskbar" class="mobile-taskbar hidden" aria-label="Mobile Navigation">
    <button type="button" id="mobHomeBtn" class="mobile-nav-btn active">
      <span>⊞</span>
      <span data-i18n="mobile.apps">Apps</span>
    </button>
    <button type="button" id="mobSearchBtn" class="mobile-nav-btn">
      <span>⌕</span>
      <span data-i18n="mobile.search">Search</span>
    </button>
    <button type="button" id="mobLockBtn" class="mobile-nav-btn">
      <span>🔒</span>
      <span data-i18n="mobile.lock">Lock</span>
    </button>
  </nav>

  <!-- Quick Launcher Spotlight (Ctrl+K) -->
  <div id="spotlightBackdrop" class="spotlight-backdrop hidden">
    <div class="spotlight-modal">
      <div class="spotlight-search-row">
        <span style="color:var(--os-accent);font-weight:700;">⌕</span>
        <input type="text" id="spotlightInput" class="spotlight-input" data-i18n-placeholder="spotlight.input_placeholder" placeholder="Launch a system module, Docker container or plugin..." autocomplete="off">
      </div>
      <div id="spotlightResults" class="spotlight-results"></div>
    </div>
  </div>

  <!-- Add App to Desktop Modal -->
  <div id="desktopModalLayer" class="spotlight-backdrop hidden"></div>

  <!-- Notification Center Drawer -->
  <aside id="notifDrawer" class="notif-drawer hidden">
    <div class="drawer-header">
      <strong data-i18n="notifications.header">System Notifications</strong>
      <div style="display:flex;gap:8px;">
        <button type="button" id="markAllReadBtn" style="font-size:0.75rem;color:var(--os-accent);" data-i18n="notifications.mark_all_read">Mark all read</button>
        <button type="button" id="clearNotifsBtn" style="font-size:0.75rem;color:var(--os-text-secondary);" data-i18n="notifications.clear">Clear</button>
      </div>
    </div>
    <div id="notifList" class="drawer-list"></div>
  </aside>

  <!-- Power & Session Menu -->
  <div id="powerPopover" class="power-popover hidden">
    <button type="button" class="ctx-item" data-power="settings" data-i18n="power.settings">Security, Language &amp; Appearance</button>
    <a href="https://github.com/12it-be/Vanill-ia-OS" target="_blank" rel="noopener noreferrer" class="ctx-item" data-power="github" style="text-decoration:none;color:inherit;justify-content:space-between;">
      <span style="display:inline-flex;align-items:center;gap:8px;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"></path>
          <path d="M9 18c-4.51 2-5-2-7-2"></path>
        </svg>
        <span data-i18n="power.github">GitHub Repository</span>
      </span>
      <span style="opacity:0.65;font-size:0.75rem;">↗</span>
    </a>
    <div class="ctx-sep"></div>
    <button type="button" class="ctx-item" data-power="lock" data-i18n="power.lock">Lock Screen</button>
    <button type="button" class="ctx-item" data-power="logout" data-i18n="power.logout">Sign Out</button>
    <div class="ctx-sep"></div>
    <button type="button" class="ctx-item" data-power="reboot" data-i18n="power.reboot">Reboot Debian</button>
    <button type="button" class="ctx-item danger" data-power="poweroff" data-i18n="power.poweroff">Shut Down Server</button>
  </div>

  <!-- Right-Click / Long-Press Context Menu -->
  <div id="contextMenu" class="context-menu hidden"></div>

  <!-- Toast Stack -->
  <div id="toastStack" class="toast-stack"></div>

  <script type="module" src="/assets/js/core/Desktop.js"></script>
</body>
</html>
