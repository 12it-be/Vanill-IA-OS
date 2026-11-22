/**
 * ==============================================================================
 * Vanill-IA OS — Docker Manager, Compose Stacks, App Store & Caddy Proxy
 * Transparent Docker administration (/opt/vanill-ia/stacks/) + 1-Click Bureau Pin
 * ==============================================================================
 */

import { getAppIconSvg } from '../core/WindowManager.js';
import { t } from '../i18n.js';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatCompactCount(num) {
  const n = Number(num) || 0;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatTagSize(bytes) {
  const b = Number(bytes) || 0;
  if (b <= 0) return '';
  if (b >= 1_073_741_824) return ` (${(b / 1_073_741_824).toFixed(2)} GB)`;
  return ` (${(b / 1_048_576).toFixed(1)} MB)`;
}

/**
 * Coloration syntaxique légère temps réel pour docker-compose.yml
 */
function highlightYaml(raw) {
  return escapeHtml(raw)
    .split('\n')
    .map((line) => {
      if (/^\s*#/.test(line)) {
        return `<span class="yc">${line}</span>`;
      }
      // Variables ${VAR:-default}
      let out = line.replace(/(\$\{[^}]+\})/g, '<span class="yv">$1</span>');
      // Clés YAML
      out = out.replace(/^(\s*-?\s*)([a-zA-Z0-9_.-]+)(:)/, '$1<span class="yk">$2</span>$3');
      // Chaînes entre guillemets
      out = out.replace(/(&quot;[^&]*&quot;|'[^']*')/g, '<span class="ys">$1</span>');
      // Nombres isolés
      out = out.replace(/(:\s+)(\d+)(\s*$)/, '$1<span class="yn">$2</span>$3');
      return out;
    })
    .join('\n') + '\n';
}

export async function mountApp({ container, api, params }) {
  let activeTab = params?.tab || 'containers';
  let overview = {
    agent_online: false,
    docker_status: { installed: false, running: false, compose_available: false, installing: false, install_exit_code: null, log_tail: '' },
    docker_info: null,
    containers: [],
    routes: [],
  };
  let stacks = [];
  let catalog = [];
  let searchQuery = '';
  let stateFilter = 'all';
  let storeCategory = 'all';
  let storeSearchQuery = '';
  let hubQuery = '';
  let hubOfficialOnly = true;
  let hubResults = [];
  let hubLoading = false;
  let hubLoadedOnce = false;
  let hubDebounceTimer = null;
  let refreshTimer = null;
  let installPollTimer = null;
  let currentStack = { name: '', compose_yml: '', env_content: '', isNew: true };

  container.innerHTML = `
    <div class="module-layout">
      <aside class="module-sidebar">
        <button type="button" class="module-nav-btn active" data-tab="containers">
          <span data-i18n="docker.tab_containers">${escapeHtml(t('docker.tab_containers'))}</span>
          <span id="navCountContainers" class="status-pill-sm status-info">0</span>
        </button>
        <button type="button" class="module-nav-btn" data-tab="stacks">
          <span data-i18n="docker.tab_stacks">${escapeHtml(t('docker.tab_stacks'))}</span>
        </button>
        <button type="button" class="module-nav-btn" data-tab="store">
          <span data-i18n="docker.tab_store">${escapeHtml(t('docker.tab_store'))}</span>
        </button>
        <button type="button" class="module-nav-btn" data-tab="proxy">
          <span data-i18n="docker.tab_proxy">${escapeHtml(t('docker.tab_proxy'))}</span>
        </button>
      </aside>
      <div class="module-content" id="dockerMainPane"></div>
    </div>
    <div id="dockerModalSlot"></div>
  `;

  const mainPane = container.querySelector('#dockerMainPane');
  const modalSlot = container.querySelector('#dockerModalSlot');
  const countBadge = container.querySelector('#navCountContainers');

  const notify = (msg, type = 'info') => window.__VANILLIA_DESKTOP__?.notify(msg, type);

  function stopInstallPolling() {
    if (installPollTimer) {
      clearInterval(installPollTimer);
      installPollTimer = null;
    }
  }

  function startInstallPolling() {
    if (installPollTimer) return;
    installPollTimer = setInterval(async () => {
      try {
        const st = await api.get('/api/docker.php?action=engine_status');
        overview.docker_status = st;
        const logPre = mainPane.querySelector('#dockerLiveInstallLog');
        if (logPre && st.log_tail) {
          logPre.textContent = st.log_tail;
          logPre.scrollTop = logPre.scrollHeight;
        }
        if (!st.installing) {
          stopInstallPolling();
          if (st.installed && st.running) {
            notify(t('docker.install_done_toast'), { level: 'success' });
            await switchTab(activeTab);
          } else {
            await switchTab(activeTab);
          }
        }
      } catch (_) {}
    }, 1500);
  }

  function renderDockerReadinessBanner() {
    const ds = overview.docker_status || {};
    if (!overview.agent_online) {
      return `<div class="os-alert os-alert-info">System daemon <code>vanill-ia-agent</code> is offline on this preview host.</div>`;
    }

    if (ds.installing) {
      startInstallPolling();
      return `
        <div class="settings-card" style="border-color:rgba(255,109,90,0.45);">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
            <div style="width:22px;height:22px;border-radius:50%;border:3px solid rgba(255,109,90,0.25);border-top-color:var(--os-accent);animation:vDockerSpin 0.85s linear infinite;flex-shrink:0;"></div>
            <style>@keyframes vDockerSpin { to { transform: rotate(360deg); } }</style>
            <h3 style="margin:0;">⚙️ ${escapeHtml(t('docker.installing_title'))}</h3>
          </div>
          <p class="desc">${escapeHtml(t('docker.installing_desc'))}</p>
          <pre class="log-console selectable" id="dockerLiveInstallLog" style="max-height:280px;">${escapeHtml(ds.log_tail || 'Initializing background installer...')}</pre>
        </div>
      `;
    }

    if (!ds.installed) {
      const prevFailed = ds.install_exit_code !== null && ds.install_exit_code !== 0 && ds.log_tail;
      return `
        <div class="settings-card" style="padding:26px;text-align:center;border-color:var(--os-border-strong);">
          <div style="width:52px;height:52px;border-radius:15px;background:rgba(14,165,233,0.16);color:#38BDF8;display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px;">
            ${getAppIconSvg('layers')}
          </div>
          <h3 style="font-size:1.08rem;margin-bottom:6px;">${escapeHtml(t('docker.baremetal_title'))}</h3>
          <p class="desc" style="max-width:560px;margin:0 auto 16px;">${escapeHtml(t('docker.baremetal_desc'))}</p>
          <button type="button" class="os-btn os-btn-primary" id="installDockerEngineBtn" style="width:auto;padding:11px 22px;">
            ⚡ ${escapeHtml(t('docker.install_engine_btn'))}
          </button>
          ${prevFailed ? `
            <details style="margin-top:16px;text-align:left;">
              <summary style="cursor:pointer;font-size:0.78rem;color:var(--os-danger);">Last installation log (exit code ${ds.install_exit_code})</summary>
              <pre class="log-console selectable" style="margin-top:8px;max-height:200px;">${escapeHtml(ds.log_tail)}</pre>
            </details>
          ` : ''}
        </div>
      `;
    }

    if (!ds.running) {
      return `
        <div class="settings-card" style="padding:24px;text-align:center;border-color:rgba(245,158,11,0.45);">
          <h3 style="color:var(--os-warning);margin-bottom:6px;">⚠️ ${escapeHtml(t('docker.stopped_service_title'))}</h3>
          <p class="desc" style="max-width:500px;margin:0 auto 14px;">${escapeHtml(t('docker.stopped_service_desc'))}</p>
          <button type="button" class="os-btn os-btn-primary" id="startDockerServiceBtn" style="width:auto;">
            ▶ ${escapeHtml(t('docker.start_service_btn'))}
          </button>
        </div>
      `;
    }

    return '';
  }

  function bindDockerReadinessButtons() {
    mainPane.querySelector('#installDockerEngineBtn')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        const st = await api.post('/api/docker.php?action=install_engine', {});
        overview.docker_status = st;
        if (activeTab === 'store') renderStoreView();
        else renderContainersView();
        startInstallPolling();
      } catch (err) {
        notify(err.message, 'error');
        e.currentTarget.disabled = false;
      }
    });

    mainPane.querySelector('#startDockerServiceBtn')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        const st = await api.post('/api/docker.php?action=start_service', {});
        overview.docker_status = st;
        await switchTab(activeTab);
      } catch (err) {
        notify(err.message, 'error');
        e.currentTarget.disabled = false;
      }
    });
  }

  const switchTab = async (tab) => {
    activeTab = tab;
    container.querySelectorAll('[data-tab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    if (tab === 'containers') {
      await loadOverview();
    } else if (tab === 'stacks') {
      await loadStacksTab();
    } else if (tab === 'store') {
      await loadStoreTab();
    } else if (tab === 'proxy') {
      await loadProxyTab();
    }
  };

  container.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // ==========================================================================
  // ONGLET 1 : CONTENEURS, STATS TEMPS RÉEL, LOGS, EXEC & OUVERTURE BUREAU
  // ==========================================================================

  async function loadOverview(silent = false) {
    if (!silent) {
      mainPane.innerHTML = `<div class="settings-card">Chargement de l'état Docker Engine...</div>`;
    }
    try {
      overview = await api.get('/api/docker.php?action=overview');
      countBadge.textContent = String((overview.containers || []).length);
      if (activeTab === 'containers') {
        renderContainersView();
      }
    } catch (err) {
      mainPane.innerHTML = `<div class="os-alert os-alert-error">${escapeHtml(err.message)}</div>`;
    }
  }

  function buildContainerWebUrl(c) {
    if (c.proxy_url) return c.proxy_url;
    if (c.web_port) {
      return `${window.location.protocol === 'https:' ? 'http:' : window.location.protocol}//${window.location.hostname}:${c.web_port}`;
    }
    return null;
  }

  function renderContainersView() {
    const ds = overview.docker_status || {};
    if (!overview.agent_online || ds.installing || !ds.installed || !ds.running) {
      mainPane.innerHTML = renderDockerReadinessBanner();
      bindDockerReadinessButtons();
      return;
    }

    const info = overview.docker_info;
    const list = (overview.containers || []).filter((c) => {
      const matchesSearch = searchQuery === '' ||
        c.name.toLowerCase().includes(searchQuery) ||
        c.image.toLowerCase().includes(searchQuery) ||
        (c.compose_stack || '').toLowerCase().includes(searchQuery);
      const matchesState = stateFilter === 'all' ||
        (stateFilter === 'running' && c.state === 'running') ||
        (stateFilter === 'stopped' && c.state !== 'running');
      return matchesSearch && matchesState;
    });

    const offlineNotice = overview.docker_error
      ? `<div class="os-alert os-alert-error">${escapeHtml(overview.docker_error)}</div>`
      : '';

    mainPane.innerHTML = `
      ${offlineNotice}

      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">${escapeHtml(t('docker.running'))}</div>
          <div class="kpi-value" style="color:var(--os-success)">${info ? info.containers_running : 0}</div>
          <div class="kpi-sub">/ ${info ? info.containers_total : 0} total</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">${escapeHtml(t('docker.stopped'))}</div>
          <div class="kpi-value">${info ? (info.containers_stopped + info.containers_paused) : 0}</div>
          <div class="kpi-sub">Ready</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">${escapeHtml(t('docker.images'))}</div>
          <div class="kpi-value">${info ? info.images : 0}</div>
          <div class="kpi-sub">Driver ${escapeHtml(info?.driver || 'overlay2')}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">${escapeHtml(t('docker.engine'))}</div>
          <div class="kpi-value" style="font-size:1.08rem;">${escapeHtml(info?.server_version || 'N/A')}</div>
          <div class="kpi-sub">${escapeHtml(info?.architecture || 'amd64')}</div>
        </div>
      </div>

      <div class="toolbar-row">
        <div style="display:flex;gap:8px;flex-wrap:wrap;flex:1;">
          <input type="search" class="os-input" id="cntSearchInput" placeholder="${escapeHtml(t('docker.filter_ph'))}" value="${escapeHtml(searchQuery)}" style="max-width:270px;padding:7px 12px;font-size:0.83rem;">
          <select class="os-select" id="cntStateSelect" style="max-width:170px;padding:7px 11px;font-size:0.83rem;">
            <option value="all" ${stateFilter === 'all' ? 'selected' : ''}>${escapeHtml(t('docker.state_all'))}</option>
            <option value="running" ${stateFilter === 'running' ? 'selected' : ''}>${escapeHtml(t('docker.state_running'))}</option>
            <option value="stopped" ${stateFilter === 'stopped' ? 'selected' : ''}>${escapeHtml(t('docker.state_stopped'))}</option>
          </select>
        </div>
        <div style="display:flex;gap:8px;">
          <button type="button" class="btn-xs" id="refreshContainersBtn">↻ ${escapeHtml(t('common.refresh'))}</button>
          <button type="button" class="btn-xs primary" id="goStoreBtn">${escapeHtml(t('docker.deploy_app'))}</button>
        </div>
      </div>

      <div class="cards-grid" id="containersGrid">
        ${list.length === 0 ? `
          <div class="settings-card" style="grid-column:1/-1;text-align:center;padding:34px;">
            <h3>${escapeHtml(t('docker.no_containers'))}</h3>
            <button type="button" class="os-btn os-btn-primary" id="emptyGoStoreBtn" style="width:auto;margin-top:10px;">${escapeHtml(t('docker.tab_store'))}</button>
          </div>
        ` : list.map((c) => renderContainerCard(c)).join('')}
      </div>
    `;

    mainPane.querySelector('#cntSearchInput')?.addEventListener('input', (e) => {
      searchQuery = e.target.value.toLowerCase();
      renderContainersView();
      const input = mainPane.querySelector('#cntSearchInput');
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    });

    mainPane.querySelector('#cntStateSelect')?.addEventListener('change', (e) => {
      stateFilter = e.target.value;
      renderContainersView();
    });

    mainPane.querySelector('#refreshContainersBtn')?.addEventListener('click', () => loadOverview(false));
    mainPane.querySelector('#goStoreBtn')?.addEventListener('click', () => switchTab('store'));
    mainPane.querySelector('#emptyGoStoreBtn')?.addEventListener('click', () => switchTab('store'));

    bindContainerCardActions();
  }

  function renderContainerCard(c) {
    const isRunning = c.state === 'running';
    const isError = !isRunning && (String(c.status).includes('Exited (') && !String(c.status).includes('Exited (0)'));
    const pillClass = isRunning ? 'status-running' : isError ? 'status-error' : 'status-stopped';
    const stats = c.live_stats;
    const webUrl = buildContainerWebUrl(c);
    const isPinned = Boolean(c.pinned_shortcut);

    const portsLabel = (c.ports || [])
      .filter((p) => p.public_port)
      .map((p) => `${p.public_port}→${p.private_port}/${p.type}`)
      .join(', ');

    return `
      <article class="entity-card" data-cid="${escapeHtml(c.id)}" data-cname="${escapeHtml(c.name)}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
          <div style="min-width:0;">
            <div style="font-weight:700;font-size:0.95rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
              ${escapeHtml(c.name)}
            </div>
            <div style="font-family:var(--font-mono);font-size:0.73rem;color:var(--os-text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
              ${escapeHtml(c.image)}
            </div>
          </div>
          <span class="status-pill-sm ${pillClass}">${escapeHtml(c.state)}</span>
        </div>

        <div style="display:flex;flex-wrap:wrap;gap:6px;font-size:0.74rem;color:var(--os-text-secondary);">
          <span>${escapeHtml(c.status)}</span>
          ${c.compose_stack ? `<span class="status-pill-sm status-info">stack: ${escapeHtml(c.compose_stack)}</span>` : ''}
        </div>

        ${stats ? `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:8px 10px;border-radius:10px;background:rgba(0,0,0,0.16);font-family:var(--font-mono);font-size:0.73rem;">
            <div>CPU: <strong>${escapeHtml(stats.cpu_percent)}</strong></div>
            <div>RAM: <strong>${escapeHtml(stats.mem_percent)}</strong></div>
            <div style="grid-column:1/-1;color:var(--os-text-secondary);">Mémoire: ${escapeHtml(stats.mem_usage)} · Net: ${escapeHtml(stats.net_io)}</div>
          </div>
        ` : ''}

        ${portsLabel ? `<div style="font-family:var(--font-mono);font-size:0.72rem;color:var(--os-text-muted);">Ports : ${escapeHtml(portsLabel)}</div>` : ''}

        ${webUrl && isRunning ? `
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button type="button" class="btn-xs primary" data-open-iframe="${escapeHtml(webUrl)}" data-title="${escapeHtml(c.name)}">🗔 ${escapeHtml(t('docker.open_window'))}</button>
            <a href="${escapeHtml(webUrl)}" target="_blank" rel="noopener noreferrer" class="btn-xs" style="text-decoration:none;">↗ ${escapeHtml(t('common.new_tab'))}</a>
            <button type="button" class="btn-xs" data-pin-container="${escapeHtml(c.name)}" data-url="${escapeHtml(webUrl)}" data-pinned="${isPinned ? '1' : '0'}">
              ${isPinned ? `★ ${escapeHtml(t('docker.pinned'))}` : `☆ ${escapeHtml(t('docker.pin_desktop'))}`}
            </button>
          </div>
        ` : ''}

        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:auto;padding-top:4px;border-top:1px solid var(--os-border);">
          ${isRunning
            ? `<button type="button" class="btn-xs" data-cact="restart">↻ ${escapeHtml(t('docker.restart'))}</button>
               <button type="button" class="btn-xs" data-cact="stop">⏹ ${escapeHtml(t('docker.stop'))}</button>
               <button type="button" class="btn-xs" data-exec="${escapeHtml(c.name)}">$_ Exec</button>`
            : `<button type="button" class="btn-xs primary" data-cact="start">▶ ${escapeHtml(t('docker.start'))}</button>`
          }
          <button type="button" class="btn-xs" data-logs="${escapeHtml(c.name)}">📄 ${escapeHtml(t('docker.logs'))}</button>
          <button type="button" class="btn-xs ai-diag" data-ai-diag="${escapeHtml(c.name)}" title="${escapeHtml(t('common.ai_diagnose'))}">✨ ${escapeHtml(t('common.ai_short'))}</button>
          <button type="button" class="btn-xs danger" data-cact="remove" style="margin-left:auto;">✕</button>
        </div>
      </article>
    `;
  }

  function bindContainerCardActions() {
    // Actions cycle de vie conteneur
    mainPane.querySelectorAll('[data-cact]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const card = btn.closest('[data-cname]');
        const name = card.dataset.cname;
        const operation = btn.dataset.cact;

        if (operation === 'remove' && !window.confirm(`Supprimer le conteneur "${name}" ?`)) {
          return;
        }

        btn.disabled = true;
        try {
          await api.post('/api/docker.php?action=container_action', {
            id: name,
            operation,
            force: operation === 'remove',
          });
          notify(`Action "${operation}" exécutée sur ${name}.`);
          await loadOverview(true);
        } catch (err) {
          notify(err.message, 'error');
          btn.disabled = false;
        }
      });
    });

    // Ouverture directe dans une fenêtre Iframe du Bureau WebOS
    mainPane.querySelectorAll('[data-open-iframe]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const url = btn.dataset.openIframe;
        const title = btn.dataset.title;
        window.__VANILLIA_DESKTOP__?.wm.open({
          app_id: `docker-live-${title.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`,
          title,
          icon: 'globe',
          accent_color: '#0EA5E9',
          open_mode: 'iframe',
          target_url: url,
          defaultWidth: 1020,
          defaultHeight: 680,
        });
      });
    });

    // Épingler / Détacher du Bureau et du Dock
    mainPane.querySelectorAll('[data-pin-container]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.pinContainer;
        const url = btn.dataset.url;
        const appId = 'app-' + name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');

        try {
          if (btn.dataset.pinned === '1') {
            await api.post('/api/system.php?action=shortcut_delete', { app_id: appId });
            notify(`${name} retiré du bureau.`);
          } else {
            await api.post('/api/system.php?action=shortcut_pin_webapp', {
              app_id: appId,
              title: name,
              subtitle: 'Conteneur Docker',
              icon: 'layers',
              accent_color: '#0EA5E9',
              target_url: url,
              container_name: name,
              open_mode: 'iframe',
              pinned_dock: true,
            });
            notify(`${name} épinglé sur le Bureau et dans le Dock !`);
          }
          await window.__VANILLIA_DESKTOP__?.loadShortcuts();
          await loadOverview(true);
        } catch (err) {
          notify(err.message, 'error');
        }
      });
    });

    // Modale Logs Live
    mainPane.querySelectorAll('[data-logs]').forEach((btn) => {
      btn.addEventListener('click', () => openLogsModal(btn.dataset.logs));
    });

    // Modale Console Exec
    mainPane.querySelectorAll('[data-exec]').forEach((btn) => {
      btn.addEventListener('click', () => openExecModal(btn.dataset.exec));
    });

    // Diagnostic IA Contextuel
    mainPane.querySelectorAll('[data-ai-diag]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.aiDiag;
        try {
          const res = await api.get(`/api/docker.php?action=container_logs&id=${encodeURIComponent(name)}&lines=120`);
          window.__VANILLIA_DESKTOP__?.launchAppById('vanill-ia-chat', {
            context_type: 'docker_diag',
            target: name,
            logs: res.logs || '(Aucun log disponible)',
          });
        } catch (err) {
          notify(err.message, 'error');
        }
      });
    });
  }

  async function openLogsModal(containerName) {
    modalSlot.innerHTML = `
      <div class="inwin-modal-backdrop">
        <div class="inwin-modal">
          <div class="inwin-modal-header">
            <span>📄 Journaux en direct — ${escapeHtml(containerName)}</span>
            <button type="button" class="btn-xs" id="closeModalBtn">Fermer</button>
          </div>
          <div class="inwin-modal-body">
            <div class="toolbar-row">
              <select class="os-select" id="logLinesSel" style="max-width:160px;padding:6px 10px;font-size:0.8rem;">
                <option value="100">100 dernières lignes</option>
                <option value="250" selected>250 dernières lignes</option>
                <option value="600">600 dernières lignes</option>
              </select>
              <div style="display:flex;gap:8px;">
                <button type="button" class="btn-xs" id="reloadLogsBtn">↻ Actualiser</button>
                <button type="button" class="btn-xs ai-diag" id="modalAiDiagBtn">✨ Diagnostiquer avec Vanill-IA</button>
              </div>
            </div>
            <pre class="log-console selectable" id="modalLogsPre">Chargement des logs...</pre>
          </div>
        </div>
      </div>
    `;

    const pre = modalSlot.querySelector('#modalLogsPre');
    const sel = modalSlot.querySelector('#logLinesSel');

    const fetchLogs = async () => {
      try {
        const res = await api.get(`/api/docker.php?action=container_logs&id=${encodeURIComponent(containerName)}&lines=${sel.value}`);
        pre.textContent = res.logs || '(Sortie vide)';
        pre.scrollTop = pre.scrollHeight;
      } catch (err) {
        pre.textContent = `Erreur : ${err.message}`;
      }
    };

    modalSlot.querySelector('#closeModalBtn').addEventListener('click', () => { modalSlot.innerHTML = ''; });
    modalSlot.querySelector('#reloadLogsBtn').addEventListener('click', fetchLogs);
    sel.addEventListener('change', fetchLogs);
    modalSlot.querySelector('#modalAiDiagBtn').addEventListener('click', () => {
      const currentLogs = pre.textContent;
      modalSlot.innerHTML = '';
      window.__VANILLIA_DESKTOP__?.launchAppById('vanill-ia-chat', {
        context_type: 'docker_diag',
        target: containerName,
        logs: currentLogs,
      });
    });

    await fetchLogs();
  }

  function openExecModal(containerName) {
    modalSlot.innerHTML = `
      <div class="inwin-modal-backdrop">
        <div class="inwin-modal">
          <div class="inwin-modal-header">
            <span>$_ Console rapide (docker exec) — ${escapeHtml(containerName)}</span>
            <button type="button" class="btn-xs" id="closeExecModalBtn">Fermer</button>
          </div>
          <div class="inwin-modal-body">
            <form id="execCmdForm" style="display:flex;gap:8px;">
              <input type="text" class="os-input" id="execCmdInput" placeholder="Ex: ls -la /app  ou  env  ou  ps aux" required style="font-family:var(--font-mono);font-size:0.84rem;">
              <button type="submit" class="os-btn os-btn-primary" style="width:auto;white-space:nowrap;">Exécuter</button>
            </form>
            <pre class="log-console selectable" id="execOutputPre"># Prêt à exécuter une commande dans ${escapeHtml(containerName)} (/bin/sh -c)</pre>
          </div>
        </div>
      </div>
    `;

    const form = modalSlot.querySelector('#execCmdForm');
    const input = modalSlot.querySelector('#execCmdInput');
    const pre = modalSlot.querySelector('#execOutputPre');
    input.focus();

    modalSlot.querySelector('#closeExecModalBtn').addEventListener('click', () => { modalSlot.innerHTML = ''; });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const command = input.value.trim();
      if (!command) return;
      pre.textContent += `\n\n$ ${command}\n...`;
      try {
        const res = await api.post('/api/docker.php?action=container_exec', { id: containerName, command });
        const out = [res.stdout, res.stderr].filter(Boolean).join('\n').trim() || `(Code retour ${res.exit_code})`;
        pre.textContent = pre.textContent.replace(/\.\.\.$/, out);
        pre.scrollTop = pre.scrollHeight;
        input.select();
      } catch (err) {
        pre.textContent = pre.textContent.replace(/\.\.\.$/, `[ERREUR] ${err.message}`);
      }
    });
  }

  // ==========================================================================
  // ONGLET 2 : STACKS DOCKER COMPOSE (/opt/vanill-ia/stacks/) & ÉDITEUR YAML
  // ==========================================================================

  async function loadStacksTab(selectedName = null) {
    try {
      const res = await api.get('/api/docker.php?action=stacks_list');
      stacks = res.stacks || [];
      if (selectedName) {
        const detail = await api.get(`/api/docker.php?action=stack_get&name=${encodeURIComponent(selectedName)}`);
        currentStack = { ...detail, isNew: false };
      } else if (stacks.length > 0 && currentStack.isNew && !currentStack.compose_yml) {
        const detail = await api.get(`/api/docker.php?action=stack_get&name=${encodeURIComponent(stacks[0].name)}`);
        currentStack = { ...detail, isNew: false };
      } else if (!currentStack.compose_yml) {
        currentStack = {
          name: 'mon-service',
          compose_yml: `services:\n  web:\n    image: nginx:alpine\n    container_name: mon-service\n    restart: unless-stopped\n    ports:\n      - "\${APP_PORT:-8090}:80"\n`,
          env_content: 'APP_PORT=8090\n',
          isNew: true,
        };
      }
      renderStacksView();
    } catch (err) {
      mainPane.innerHTML = `<div class="os-alert os-alert-error">${escapeHtml(err.message)}</div>`;
    }
  }

  function renderStacksView() {
    mainPane.innerHTML = `
      <div class="toolbar-row">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <select class="os-select" id="stackPicker" style="max-width:230px;padding:7px 12px;">
            <option value="__new__" ${currentStack.isNew ? 'selected' : ''}>+ Nouvelle Stack Compose</option>
            ${stacks.map((s) => `<option value="${escapeHtml(s.name)}" ${!currentStack.isNew && currentStack.name === s.name ? 'selected' : ''}>stack: ${escapeHtml(s.name)}</option>`).join('')}
          </select>
          <input type="text" class="os-input" id="stackNameInput" value="${escapeHtml(currentStack.name)}" ${currentStack.isNew ? '' : 'readonly'} placeholder="nom-de-la-stack" style="max-width:200px;padding:7px 12px;font-family:var(--font-mono);">
          <span style="font-size:0.75rem;color:var(--os-text-muted);font-family:var(--font-mono);">/opt/vanill-ia/stacks/${escapeHtml(currentStack.name || '<nom>')}/docker-compose.yml</span>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button type="button" class="btn-xs" id="saveStackBtn">💾 Enregistrer & Valider</button>
          <button type="button" class="btn-xs primary" id="deployStackBtn">🚀 Déployer (Up -d)</button>
          ${!currentStack.isNew ? `
            <button type="button" class="btn-xs" data-sact="pull">⬇ Pull</button>
            <button type="button" class="btn-xs" data-sact="restart">↻ Restart</button>
            <button type="button" class="btn-xs" data-sact="down">⏹ Down</button>
            <button type="button" class="btn-xs danger" data-sact="delete">✕ Supprimer</button>
          ` : ''}
        </div>
      </div>

      <div>
        <label class="form-label">docker-compose.yml (Coloration YAML temps réel · Tab = 2 espaces)</label>
        <div class="yaml-editor-shell">
          <div class="yaml-gutter" id="yamlGutter">1</div>
          <div class="yaml-stage">
            <pre class="yaml-highlight" id="yamlHighlight" aria-hidden="true"></pre>
            <textarea class="yaml-textarea" id="yamlTextarea" spellcheck="false"></textarea>
          </div>
        </div>
      </div>

      <div>
        <label class="form-label">Variables d'environnement (.env optionnel)</label>
        <textarea class="os-input" id="stackEnvTextarea" rows="3" spellcheck="false" style="font-family:var(--font-mono);font-size:0.8rem;" placeholder="APP_PORT=8080">${escapeHtml(currentStack.env_content || '')}</textarea>
      </div>

      <pre class="log-console hidden selectable" id="stackActionOutput"></pre>
    `;

    const textarea = mainPane.querySelector('#yamlTextarea');
    const highlight = mainPane.querySelector('#yamlHighlight');
    const gutter = mainPane.querySelector('#yamlGutter');
    const nameInput = mainPane.querySelector('#stackNameInput');
    const envArea = mainPane.querySelector('#stackEnvTextarea');
    const outputPre = mainPane.querySelector('#stackActionOutput');

    textarea.value = currentStack.compose_yml;

    const syncEditor = () => {
      const val = textarea.value;
      highlight.innerHTML = highlightYaml(val);
      const linesCount = val.split('\n').length;
      gutter.innerHTML = Array.from({ length: linesCount }, (_, i) => i + 1).join('<br>');
    };

    textarea.addEventListener('input', syncEditor);
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 2;
        syncEditor();
      }
    });
    syncEditor();

    mainPane.querySelector('#stackPicker').addEventListener('change', async (e) => {
      const v = e.target.value;
      if (v === '__new__') {
        currentStack = {
          name: 'nouvelle-stack',
          compose_yml: `services:\n  app:\n    image: nginx:alpine\n    restart: unless-stopped\n    ports:\n      - "8095:80"\n`,
          env_content: '',
          isNew: true,
        };
        renderStacksView();
      } else {
        await loadStacksTab(v);
      }
    });

    const saveCurrent = async () => {
      const name = nameInput.value.trim().toLowerCase();
      await api.post('/api/docker.php?action=stack_save', {
        name,
        compose_yml: textarea.value,
        env_content: envArea.value,
      });
      currentStack = { name, compose_yml: textarea.value, env_content: envArea.value, isNew: false };
      return name;
    };

    mainPane.querySelector('#saveStackBtn').addEventListener('click', async () => {
      try {
        const name = await saveCurrent();
        notify(`Stack "${name}" enregistrée et validée par Docker Compose.`);
        await loadStacksTab(name);
      } catch (err) {
        notify(err.message, 'error');
      }
    });

    mainPane.querySelector('#deployStackBtn').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      outputPre.classList.remove('hidden');
      outputPre.textContent = 'Enregistrement et exécution de `docker compose up -d --remove-orphans`...';
      try {
        const name = await saveCurrent();
        const res = await api.post('/api/docker.php?action=stack_action', { name, operation: 'up' });
        outputPre.textContent = res.output || 'Stack déployée avec succès.';
        notify(`Stack "${name}" déployée !`);
      } catch (err) {
        outputPre.textContent = `[ERREUR] ${err.message}`;
        notify(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });

    mainPane.querySelectorAll('[data-sact]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const op = btn.dataset.sact;
        if (op === 'delete' && !window.confirm(`Arrêter et supprimer la stack "${currentStack.name}" ?`)) {
          return;
        }
        outputPre.classList.remove('hidden');
        outputPre.textContent = `Exécution de docker compose ${op}...`;
        try {
          const res = await api.post('/api/docker.php?action=stack_action', { name: currentStack.name, operation: op });
          outputPre.textContent = res.output || 'Opération terminée.';
          notify(`Opération "${op}" terminée sur ${currentStack.name}.`);
          if (op === 'delete') {
            currentStack = { name: '', compose_yml: '', env_content: '', isNew: true };
            await loadStacksTab();
          }
        } catch (err) {
          outputPre.textContent = `[ERREUR] ${err.message}`;
          notify(err.message, 'error');
        }
      });
    });
  }

  // ==========================================================================
  // TAB 3: APP STORE CATALOG & OFFICIAL DOCKER HUB SEARCH
  // ==========================================================================

  async function loadStoreTab() {
    try {
      const res = await api.get('/api/docker.php?action=store_catalog&refresh=0');
      catalog = res.catalog || [];
      if (res.docker_status) {
        overview.docker_status = res.docker_status;
      }
      if (typeof res.agent_online === 'boolean') {
        overview.agent_online = res.agent_online;
      }
      renderStoreView();
      if (!hubLoadedOnce) {
        hubLoadedOnce = true;
        fetchHubResults();
      }
    } catch (err) {
      mainPane.innerHTML = `<div class="os-alert os-alert-error">${escapeHtml(err.message)}</div>`;
    }
  }

  async function fetchHubResults() {
    hubLoading = true;
    renderHubResultsZone();
    try {
      const res = await api.get(
        `/api/docker.php?action=hub_search&q=${encodeURIComponent(hubQuery)}&official_only=${hubOfficialOnly ? '1' : '0'}`
      );
      hubResults = res.results || [];
    } catch (err) {
      hubResults = [];
      const zone = mainPane.querySelector('#hubResultsZone');
      if (zone) {
        zone.innerHTML = `<div class="os-alert os-alert-error" style="grid-column:1/-1;">${escapeHtml(err.message)}</div>`;
        hubLoading = false;
        return;
      }
    }
    hubLoading = false;
    renderHubResultsZone();
  }

  function renderHubResultsZone() {
    const zone = mainPane.querySelector('#hubResultsZone');
    if (!zone) return;

    const ds = overview.docker_status || {};
    const dockerReady = overview.agent_online && ds.installed && ds.running && !ds.installing;

    if (hubLoading) {
      zone.innerHTML = `<div class="settings-card" style="grid-column:1/-1;text-align:center;padding:24px;">${escapeHtml(t('common.loading'))}</div>`;
      return;
    }

    if (hubResults.length === 0) {
      zone.innerHTML = `<div class="settings-card" style="grid-column:1/-1;text-align:center;padding:24px;color:var(--os-text-secondary);">${escapeHtml(t('docker.hub_no_results'))}</div>`;
      return;
    }

    zone.innerHTML = hubResults.map((item, idx) => `
      <article class="entity-card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
          <div style="min-width:0;">
            <strong style="font-family:var(--font-mono);font-size:0.95rem;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
              ${escapeHtml(item.repo_name)}
            </strong>
          </div>
          ${item.is_official ? `<span class="status-pill-sm status-running">✓ ${escapeHtml(t('docker.hub_official_badge'))}</span>` : ''}
        </div>

        <div style="font-size:0.79rem;color:var(--os-text-secondary);line-height:1.45;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;min-height:36px;">
          ${escapeHtml(item.short_description || '—')}
        </div>

        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:auto;padding-top:8px;border-top:1px solid var(--os-border);">
          <div style="display:flex;gap:10px;font-family:var(--font-mono);font-size:0.73rem;color:var(--os-text-muted);">
            <span>★ ${formatCompactCount(item.star_count)}</span>
            <span>⬇ ${formatCompactCount(item.pull_count)}</span>
          </div>
          <button type="button" class="btn-xs primary" data-hub-deploy="${idx}" ${!dockerReady ? 'disabled style="opacity:0.45;"' : ''}>
            🚀 ${escapeHtml(t('docker.hub_deploy_btn'))}
          </button>
        </div>
      </article>
    `).join('');

    zone.querySelectorAll('[data-hub-deploy]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const picked = hubResults[Number(btn.dataset.hubDeploy)];
        if (picked) openHubDeployModal(picked);
      });
    });
  }

  function renderStoreView() {
    const categories = ['all', ...new Set(catalog.map((a) => a.category))];
    const qLower = storeSearchQuery.trim().toLowerCase();
    const filtered = catalog.filter((a) => {
      const catOk = storeCategory === 'all' || a.category === storeCategory;
      const searchOk = qLower === '' ||
        a.name.toLowerCase().includes(qLower) ||
        (a.tagline || '').toLowerCase().includes(qLower) ||
        (a.description || '').toLowerCase().includes(qLower);
      return catOk && searchOk;
    });

    const ds = overview.docker_status || {};
    const dockerReady = overview.agent_online && ds.installed && ds.running && !ds.installing;
    const readinessHtml = !dockerReady ? renderDockerReadinessBanner() : '';
    const quickTags = ['nginx', 'postgres', 'redis', 'mariadb', 'grafana', 'wordpress', 'caddy', 'alpine'];

    mainPane.innerHTML = `
      ${readinessHtml}

      <!-- SECTION 1: READY-TO-USE COMPOSE APP CATALOG -->
      <div class="settings-card" style="padding:15px 18px;">
        <div class="toolbar-row" style="margin-bottom:10px;">
          <div>
            <h3 style="margin:0;">📦 ${escapeHtml(t('docker.catalog_section_title'))}</h3>
            <p class="desc" style="margin:2px 0 0;">${escapeHtml(t('docker.catalog_section_desc'))}</p>
          </div>
          <button type="button" class="btn-xs" id="refreshOnlineCatalogBtn">🔄 ${escapeHtml(t('docker.catalog_refresh_btn'))}</button>
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <input type="search" class="os-input" id="storeSearchInput" value="${escapeHtml(storeSearchQuery)}" placeholder="${escapeHtml(t('docker.catalog_search_ph'))}" style="max-width:280px;padding:7px 12px;font-size:0.83rem;">
          <select class="os-select" id="storeCategorySel" style="max-width:220px;padding:7px 12px;font-size:0.83rem;">
            ${categories.map((cat) => `<option value="${escapeHtml(cat)}" ${storeCategory === cat ? 'selected' : ''}>${cat === 'all' ? escapeHtml(t('docker.catalog_all_cats')) : escapeHtml(cat)}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="cards-grid">
        ${filtered.map((app) => `
          <article class="entity-card">
            <div style="display:flex;align-items:center;gap:12px;">
              <span class="app-squircle" style="width:46px;height:46px;border-radius:13px;margin:0;background:${escapeHtml(app.accent_color)}">
                ${getAppIconSvg(app.icon)}
              </span>
              <div style="min-width:0;flex:1;">
                <div style="display:flex;align-items:center;gap:7px;">
                  <strong style="font-size:0.96rem;">${escapeHtml(app.name)}</strong>
                  ${app.installed ? `<span class="status-pill-sm status-running">✓</span>` : ''}
                </div>
                <div style="font-size:0.74rem;color:var(--os-text-secondary);">${escapeHtml(app.category)} · Port ${app.default_port}</div>
              </div>
            </div>

            <div style="font-size:0.82rem;font-weight:500;">${escapeHtml(app.tagline)}</div>
            <div style="font-size:0.78rem;color:var(--os-text-secondary);line-height:1.45;">${escapeHtml(app.description)}</div>

            <div style="display:flex;gap:8px;margin-top:auto;padding-top:6px;">
              <button type="button" class="btn-xs primary" data-deploy-slug="${escapeHtml(app.slug)}" ${!dockerReady ? 'disabled style="opacity:0.45;"' : ''}>
                ${app.installed ? '↻ Redeploy' : '⚡ 1-Click Install'}
              </button>
              <button type="button" class="btn-xs" data-edit-template="${escapeHtml(app.slug)}" ${!dockerReady ? 'disabled style="opacity:0.45;"' : ''}>YAML</button>
            </div>
          </article>
        `).join('')}
      </div>

      <!-- SECTION 2: OFFICIAL DOCKER HUB SEARCH -->
      <div class="settings-card" style="padding:16px 18px;margin-top:8px;">
        <div class="toolbar-row" style="margin-bottom:10px;">
          <div>
            <h3 style="margin:0;">🐳 ${escapeHtml(t('docker.hub_section_title'))}</h3>
            <p class="desc" style="margin:2px 0 0;">${escapeHtml(t('docker.hub_section_desc'))}</p>
          </div>
          <label style="display:inline-flex;align-items:center;gap:7px;font-size:0.82rem;font-weight:600;cursor:pointer;">
            <input type="checkbox" id="hubOfficialChk" ${hubOfficialOnly ? 'checked' : ''}>
            ${escapeHtml(t('docker.hub_official_only'))}
          </label>
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <input type="search" class="os-input" id="hubSearchInput" value="${escapeHtml(hubQuery)}" placeholder="${escapeHtml(t('docker.hub_search_ph'))}" style="flex:1;min-width:240px;padding:8px 13px;font-size:0.85rem;">
        </div>

        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">
          ${quickTags.map((qt) => `<button type="button" class="btn-xs" data-hub-preset="${qt}" style="font-family:var(--font-mono);">${qt}</button>`).join('')}
        </div>
      </div>

      <div class="cards-grid" id="hubResultsZone"></div>
    `;

    bindDockerReadinessButtons();
    renderHubResultsZone();

    mainPane.querySelector('#refreshOnlineCatalogBtn').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const res = await api.get('/api/docker.php?action=store_catalog&refresh=1');
        catalog = res.catalog || [];
        notify(t('docker.catalog_refreshed_toast'), { level: 'success' });
        renderStoreView();
      } catch (err) {
        notify(err.message, 'error');
        btn.disabled = false;
      }
    });

    const catSearch = mainPane.querySelector('#storeSearchInput');
    catSearch.addEventListener('input', () => {
      storeSearchQuery = catSearch.value;
      renderStoreView();
      const inp = mainPane.querySelector('#storeSearchInput');
      inp?.focus();
      inp?.setSelectionRange(inp.value.length, inp.value.length);
    });

    mainPane.querySelector('#storeCategorySel').addEventListener('change', (e) => {
      storeCategory = e.target.value;
      renderStoreView();
    });

    const hubInput = mainPane.querySelector('#hubSearchInput');
    hubInput.addEventListener('input', () => {
      hubQuery = hubInput.value;
      if (hubDebounceTimer) clearTimeout(hubDebounceTimer);
      hubDebounceTimer = setTimeout(() => {
        fetchHubResults();
      }, 400);
    });

    mainPane.querySelector('#hubOfficialChk').addEventListener('change', (e) => {
      hubOfficialOnly = e.target.checked;
      fetchHubResults();
    });

    mainPane.querySelectorAll('[data-hub-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        hubQuery = btn.dataset.hubPreset;
        hubInput.value = hubQuery;
        fetchHubResults();
      });
    });

    mainPane.querySelectorAll('[data-edit-template]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tpl = catalog.find((x) => x.slug === btn.dataset.editTemplate);
        if (!tpl) return;
        currentStack = {
          name: tpl.slug,
          compose_yml: tpl.compose_yml,
          env_content: `APP_PORT=${tpl.default_port}\n`,
          isNew: !tpl.installed,
        };
        switchTab('stacks');
      });
    });

    mainPane.querySelectorAll('[data-deploy-slug]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tpl = catalog.find((x) => x.slug === btn.dataset.deploySlug);
        if (tpl) openDeployModal(tpl);
      });
    });
  }

  /**
   * Opens the Quick Configuration & Deployment Modal for any Docker Hub image.
   */
  async function openHubDeployModal(repoItem) {
    const repoName = repoItem.repo_name;
    const defaultSlug = repoName.split('/').pop().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'app';

    modalSlot.innerHTML = `
      <div class="inwin-modal-backdrop">
        <div class="inwin-modal" style="max-width:620px;">
          <div class="inwin-modal-header">
            <span>🐳 ${escapeHtml(t('docker.hub_modal_title'))} — <code>${escapeHtml(repoName)}</code></span>
            <button type="button" class="btn-xs" id="closeHubDeployModal">${escapeHtml(t('common.close'))}</button>
          </div>

          <div class="inwin-modal-body">
            <form id="hubDeployForm" style="display:flex;flex-direction:column;gap:12px;">
              <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;">
                <div>
                  <label class="form-label">${escapeHtml(t('docker.hub_service_name'))}</label>
                  <input type="text" class="os-input" name="name" id="hubSvcNameInp" value="${escapeHtml(defaultSlug)}" pattern="[a-z0-9][a-z0-9_-]{0,47}" required style="font-family:var(--font-mono);">
                </div>
                <div>
                  <label class="form-label">${escapeHtml(t('docker.hub_tag_label'))}</label>
                  <select class="os-select" name="tag" id="hubTagSelect" style="font-family:var(--font-mono);">
                    <option value="latest">latest</option>
                  </select>
                </div>
                <div>
                  <label class="form-label">${escapeHtml(t('docker.hub_restart_label'))}</label>
                  <select class="os-select" name="restart_policy">
                    <option value="unless-stopped" selected>unless-stopped</option>
                    <option value="always">always</option>
                    <option value="on-failure">on-failure</option>
                    <option value="no">no</option>
                  </select>
                </div>
              </div>

              <!-- Dynamic Ports -->
              <div class="settings-card" style="padding:12px;">
                <div class="toolbar-row" style="margin-bottom:8px;">
                  <label class="form-label" style="margin:0;">${escapeHtml(t('docker.hub_ports_label'))}</label>
                  <button type="button" class="btn-xs" id="hubAddPortBtn">${escapeHtml(t('docker.hub_add_port'))}</button>
                </div>
                <div id="hubPortsRows" style="display:flex;flex-direction:column;gap:6px;"></div>
              </div>

              <!-- Dynamic Volumes -->
              <div class="settings-card" style="padding:12px;">
                <div class="toolbar-row" style="margin-bottom:8px;">
                  <label class="form-label" style="margin:0;">${escapeHtml(t('docker.hub_volumes_label'))}</label>
                  <button type="button" class="btn-xs" id="hubAddVolBtn">${escapeHtml(t('docker.hub_add_volume'))}</button>
                </div>
                <div id="hubVolsRows" style="display:flex;flex-direction:column;gap:6px;"></div>
              </div>

              <!-- Dynamic Environment Variables -->
              <div class="settings-card" style="padding:12px;">
                <div class="toolbar-row" style="margin-bottom:8px;">
                  <label class="form-label" style="margin:0;">${escapeHtml(t('docker.hub_env_label'))}</label>
                  <button type="button" class="btn-xs" id="hubAddEnvBtn">${escapeHtml(t('docker.hub_add_env'))}</button>
                </div>
                <div id="hubEnvsRows" style="display:flex;flex-direction:column;gap:6px;"></div>
              </div>

              <label style="display:inline-flex;align-items:center;gap:8px;font-size:0.83rem;cursor:pointer;">
                <input type="checkbox" name="pin_desktop" checked>
                ${escapeHtml(t('docker.hub_pin_desktop'))}
              </label>

              <button type="submit" class="os-btn os-btn-primary" id="hubConfirmDeployBtn">🚀 ${escapeHtml(t('docker.hub_launch_deploy'))}</button>
            </form>

            <pre class="log-console hidden selectable" id="hubDeployLogPre"></pre>
          </div>
        </div>
      </div>
    `;

    modalSlot.querySelector('#closeHubDeployModal').addEventListener('click', () => { modalSlot.innerHTML = ''; });

    const nameInp = modalSlot.querySelector('#hubSvcNameInp');
    const tagSel = modalSlot.querySelector('#hubTagSelect');
    const portsBox = modalSlot.querySelector('#hubPortsRows');
    const volsBox = modalSlot.querySelector('#hubVolsRows');
    const envsBox = modalSlot.querySelector('#hubEnvsRows');
    const logPre = modalSlot.querySelector('#hubDeployLogPre');
    const submitBtn = modalSlot.querySelector('#hubConfirmDeployBtn');

    const appendPortRow = (hostVal = '', contVal = '', proto = 'tcp') => {
      const row = document.createElement('div');
      row.style.cssText = 'display:grid;grid-template-columns:1fr auto 1fr 90px auto;gap:6px;align-items:center;';
      row.innerHTML = `
        <input type="number" class="os-input" data-p-host placeholder="8080" value="${escapeHtml(hostVal)}" min="1" max="65535" style="min-width:0;padding:6px 10px;font-family:var(--font-mono);">
        <span>:</span>
        <input type="number" class="os-input" data-p-cont placeholder="80" value="${escapeHtml(contVal)}" min="1" max="65535" style="min-width:0;padding:6px 10px;font-family:var(--font-mono);">
        <select class="os-select" data-p-proto style="min-width:0;padding:6px 8px;">
          <option value="tcp" ${proto === 'tcp' ? 'selected' : ''}>TCP</option>
          <option value="udp" ${proto === 'udp' ? 'selected' : ''}>UDP</option>
        </select>
        <button type="button" class="btn-xs danger" data-rm-row>✕</button>
      `;
      row.querySelector('[data-rm-row]').addEventListener('click', () => row.remove());
      portsBox.appendChild(row);
    };

    const appendVolRow = (hostPath = '', contPath = '/data') => {
      const slugNow = nameInp.value.trim() || defaultSlug;
      const resolvedHost = hostPath || `/var/lib/vanill-ia-os/stacks/${slugNow}/data`;
      const row = document.createElement('div');
      row.style.cssText = 'display:grid;grid-template-columns:1.4fr auto 1fr auto;gap:6px;align-items:center;';
      row.innerHTML = `
        <input type="text" class="os-input" data-v-host value="${escapeHtml(resolvedHost)}" placeholder="/var/lib/vanill-ia-os/stacks/${escapeHtml(slugNow)}/data" style="min-width:0;padding:6px 10px;font-family:var(--font-mono);font-size:0.78rem;">
        <span>:</span>
        <input type="text" class="os-input" data-v-cont value="${escapeHtml(contPath)}" placeholder="/data" style="min-width:0;padding:6px 10px;font-family:var(--font-mono);font-size:0.78rem;">
        <button type="button" class="btn-xs danger" data-rm-row>✕</button>
      `;
      row.querySelector('[data-rm-row]').addEventListener('click', () => row.remove());
      volsBox.appendChild(row);
    };

    const appendEnvRow = (keyVal = '', valStr = '') => {
      const row = document.createElement('div');
      row.style.cssText = 'display:grid;grid-template-columns:1fr auto 1.3fr auto;gap:6px;align-items:center;';
      row.innerHTML = `
        <input type="text" class="os-input" data-e-key value="${escapeHtml(keyVal)}" placeholder="KEY" style="min-width:0;padding:6px 10px;font-family:var(--font-mono);font-size:0.79rem;">
        <span>=</span>
        <input type="text" class="os-input" data-e-val value="${escapeHtml(valStr)}" placeholder="value" style="min-width:0;padding:6px 10px;font-family:var(--font-mono);font-size:0.79rem;">
        <button type="button" class="btn-xs danger" data-rm-row>✕</button>
      `;
      row.querySelector('[data-rm-row]').addEventListener('click', () => row.remove());
      envsBox.appendChild(row);
    };

    // Pre-seed 1 port row + 1 persistent volume row for quick convenience
    appendPortRow('', '');
    appendVolRow('', '');

    modalSlot.querySelector('#hubAddPortBtn').addEventListener('click', () => appendPortRow());
    modalSlot.querySelector('#hubAddVolBtn').addEventListener('click', () => appendVolRow('', '/data'));
    modalSlot.querySelector('#hubAddEnvBtn').addEventListener('click', () => appendEnvRow());

    // Load official tags asynchronously from Docker Hub API
    api.get(`/api/docker.php?action=hub_tags&repo=${encodeURIComponent(repoName)}`)
      .then((res) => {
        const tags = res.tags || [];
        if (tags.length > 0) {
          tagSel.innerHTML = tags.map((tg) => `
            <option value="${escapeHtml(tg.name)}">${escapeHtml(tg.name)}${escapeHtml(formatTagSize(tg.full_size))}</option>
          `).join('');
        }
      })
      .catch(() => {});

    modalSlot.querySelector('#hubDeployForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);

      const ports = [];
      portsBox.querySelectorAll('div').forEach((r) => {
        const host = r.querySelector('[data-p-host]')?.value.trim() || '';
        const container = r.querySelector('[data-p-cont]')?.value.trim() || '';
        const proto = r.querySelector('[data-p-proto]')?.value || 'tcp';
        if (host && container) {
          ports.push({ host, container, proto });
        }
      });

      const volumes = [];
      volsBox.querySelectorAll('div').forEach((r) => {
        const host = r.querySelector('[data-v-host]')?.value.trim() || '';
        const container = r.querySelector('[data-v-cont]')?.value.trim() || '';
        if (host && container) {
          volumes.push({ host, container });
        }
      });

      const env = [];
      envsBox.querySelectorAll('div').forEach((r) => {
        const key = r.querySelector('[data-e-key]')?.value.trim() || '';
        const value = r.querySelector('[data-e-val]')?.value ?? '';
        if (key) {
          env.push({ key, value });
        }
      });

      submitBtn.disabled = true;
      logPre.classList.remove('hidden');
      logPre.textContent = `Generating docker-compose.yml and deploying ${repoName}:${fd.get('tag')}...`;

      try {
        const res = await api.post('/api/docker.php?action=deploy_image', {
          name: fd.get('name'),
          image: repoName,
          tag: fd.get('tag'),
          restart_policy: fd.get('restart_policy'),
          ports,
          volumes,
          env,
          pin_desktop: fd.get('pin_desktop') === 'on',
        });

        await window.__VANILLIA_DESKTOP__?.loadShortcuts();
        notify(t('docker.hub_deployed_toast', { image: res.image }), { level: 'success' });
        modalSlot.innerHTML = '';
        await switchTab('containers');
      } catch (err) {
        logPre.textContent = `[ERROR] ${err.message}`;
        submitBtn.disabled = false;
      }
    });
  }

  function openDeployModal(tpl) {
    modalSlot.innerHTML = `
      <div class="inwin-modal-backdrop">
        <div class="inwin-modal" style="max-width:500px;">
          <div class="inwin-modal-header">
            <span>⚡ Déployer ${escapeHtml(tpl.name)}</span>
            <button type="button" class="btn-xs" id="closeDeployModal">Fermer</button>
          </div>
          <div class="inwin-modal-body">
            <form id="deployAppForm">
              <div class="form-group">
                <label class="form-label">Port d'exposition sur le serveur Debian</label>
                <input type="number" class="os-input" name="port" value="${tpl.default_port}" min="1" max="65535" required>
              </div>
              <div class="form-group">
                <label class="form-label">Mode d'ouverture depuis le Bureau</label>
                <select class="os-select" name="open_mode">
                  <option value="iframe">Fenêtre intégrée au Bureau WebOS (iframe)</option>
                  <option value="tab">Nouvel onglet du navigateur</option>
                </select>
              </div>
              <div class="form-group">
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:0.84rem;">
                  <input type="checkbox" name="pin_desktop" checked>
                  Épingler automatiquement l'icône sur le Bureau et dans le Dock
                </label>
              </div>
              <button type="submit" class="os-btn os-btn-primary" id="confirmDeployBtn">Lancer le téléchargement & déploiement</button>
            </form>
            <pre class="log-console hidden" id="deployLogPre"></pre>
          </div>
        </div>
      </div>
    `;

    modalSlot.querySelector('#closeDeployModal').addEventListener('click', () => { modalSlot.innerHTML = ''; });
    const form = modalSlot.querySelector('#deployAppForm');
    const logPre = modalSlot.querySelector('#deployLogPre');
    const submitBtn = modalSlot.querySelector('#confirmDeployBtn');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submitBtn.disabled = true;
      logPre.classList.remove('hidden');
      logPre.textContent = `Création de /opt/vanill-ia/stacks/${tpl.slug}/docker-compose.yml et lancement de Docker Compose...`;

      const fd = new FormData(form);
      try {
        const res = await api.post('/api/docker.php?action=catalog_deploy', {
          slug: tpl.slug,
          port: Number(fd.get('port')),
          open_mode: fd.get('open_mode'),
          pin_desktop: fd.get('pin_desktop') === 'on',
        });
        await window.__VANILLIA_DESKTOP__?.loadShortcuts();
        notify(`${tpl.name} déployé avec succès sur le port ${res.port} !`);
        modalSlot.innerHTML = '';
        switchTab('containers');
      } catch (err) {
        logPre.textContent = `[ERREUR] ${err.message}`;
        submitBtn.disabled = false;
      }
    });
  }

  // ==========================================================================
  // ONGLET 4 : REVERSE PROXY CADDY EN 2 CLICS (/etc/caddy/conf.d/app-*.caddy)
  // ==========================================================================

  async function loadProxyTab() {
    try {
      overview = await api.get('/api/docker.php?action=overview');
      renderProxyView();
    } catch (err) {
      mainPane.innerHTML = `<div class="os-alert os-alert-error">${escapeHtml(err.message)}</div>`;
    }
  }

  function renderProxyView() {
    const routes = overview.routes || [];
    const runningWithPort = (overview.containers || []).filter((c) => c.web_port);

    mainPane.innerHTML = `
      <div class="settings-card">
        <h3>Associer un Sous-Domaine HTTPS à un Conteneur (2 clics)</h3>
        <p class="desc">Génère automatiquement le fichier dans <code>/etc/caddy/conf.d/</code>, vérifie la syntaxe via <code>caddy validate</code> (avec rollback auto) et recharge Caddy sans coupure.</p>

        <form id="proxyCreateForm" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(185px,1fr));gap:12px;align-items:end;">
          <div>
            <label class="form-label">Pré-remplir depuis un conteneur</label>
            <select class="os-select" id="proxyContainerPreset">
              <option value="">— Saisie manuelle —</option>
              ${runningWithPort.map((c) => `<option value="${escapeHtml(c.name)}" data-port="${c.web_port}">${escapeHtml(c.name)} (port ${c.web_port})</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="form-label">Sous-domaine complet (FQDN)</label>
            <input type="text" class="os-input" name="fqdn" placeholder="jellyfin.monserveur.be" required>
          </div>
          <div>
            <label class="form-label">Hôte & Port local cible</label>
            <div style="display:flex;gap:6px;">
              <input type="text" class="os-input" name="target_host" value="127.0.0.1" style="width:58%;">
              <input type="number" class="os-input" name="target_port" id="proxyTargetPort" placeholder="8096" min="1" max="65535" required style="width:42%;">
            </div>
          </div>
          <div>
            <label class="form-label">Certificat HTTPS</label>
            <select class="os-select" name="tls_mode">
              <option value="auto">HTTPS Auto (Let's Encrypt)</option>
              <option value="internal">HTTPS Local (Caddy Internal CA)</option>
              <option value="off">HTTP uniquement</option>
            </select>
          </div>
          <div>
            <button type="submit" class="os-btn os-btn-primary">Activer la route Caddy</button>
          </div>
        </form>
      </div>

      <div class="settings-card">
        <h3>Routes Reverse Proxy Actives (${routes.length})</h3>
        ${routes.length === 0 ? `<p class="desc" style="margin:6px 0 0;">Aucune route reverse proxy configurée pour le moment.</p>` : `
          <div class="clean-table-wrap" style="margin-top:10px;">
            <table class="clean-table">
              <thead>
                <tr>
                  <th>Domaine Public / LAN</th>
                  <th>Cible Locale</th>
                  <th>Mode TLS</th>
                  <th>Fichier Caddy</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${routes.map((r) => {
                  const url = `${r.tls_mode === 'off' ? 'http' : 'https'}://${r.fqdn}`;
                  return `
                    <tr>
                      <td><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" style="color:var(--os-accent);font-weight:600;">${escapeHtml(url)} ↗</a></td>
                      <td style="font-family:var(--font-mono);">${escapeHtml(r.target_scheme)}://${escapeHtml(r.target_host)}:${r.target_port}</td>
                      <td><span class="status-pill-sm status-running">${escapeHtml(r.tls_mode)}</span></td>
                      <td style="font-family:var(--font-mono);font-size:0.75rem;color:var(--os-text-secondary);">${escapeHtml(r.config_path)}</td>
                      <td style="text-align:right;">
                        <button type="button" class="btn-xs danger" data-del-route="${r.id}">Supprimer</button>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>
    `;

    const preset = mainPane.querySelector('#proxyContainerPreset');
    const portInput = mainPane.querySelector('#proxyTargetPort');
    const form = mainPane.querySelector('#proxyCreateForm');

    preset.addEventListener('change', () => {
      const opt = preset.selectedOptions[0];
      if (opt && opt.dataset.port) {
        portInput.value = opt.dataset.port;
        if (!form.elements.fqdn.value) {
          form.elements.fqdn.placeholder = `${opt.value}.monserveur.be`;
        }
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      try {
        await api.post('/api/docker.php?action=proxy_save', {
          fqdn: fd.get('fqdn'),
          target_host: fd.get('target_host'),
          target_port: Number(fd.get('target_port')),
          target_scheme: 'http',
          tls_mode: fd.get('tls_mode'),
          container_name: preset.value || null,
        });
        notify('Route HTTPS enregistrée et Caddy rechargé !');
        await loadProxyTab();
      } catch (err) {
        notify(err.message, 'error');
      }
    });

    mainPane.querySelectorAll('[data-del-route]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!window.confirm('Supprimer cette route Reverse Proxy Caddy ?')) return;
        try {
          await api.post('/api/docker.php?action=proxy_delete', { id: Number(btn.dataset.delRoute) });
          notify('Route supprimée.');
          await loadProxyTab();
        } catch (err) {
          notify(err.message, 'error');
        }
      });
    });
  }

  // Rafraîchissement automatique léger toutes les 5s sur l'onglet Conteneurs
  refreshTimer = setInterval(() => {
    if (activeTab === 'containers' && !document.hidden && modalSlot.innerHTML === '') {
      loadOverview(true);
    }
  }, 5000);

  const onLangChanged = () => switchTab(activeTab);
  window.addEventListener('vanillia:lang-changed', onLangChanged);

  await switchTab(activeTab);

  return {
    cleanup() {
      if (refreshTimer) clearInterval(refreshTimer);
      if (hubDebounceTimer) clearTimeout(hubDebounceTimer);
      stopInstallPolling();
      window.removeEventListener('vanillia:lang-changed', onLangChanged);
    },
    onLaunch(newParams) {
      if (newParams?.tab) switchTab(newParams.tab);
    },
  };
}
