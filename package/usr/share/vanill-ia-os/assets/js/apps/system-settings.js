/**
 * ==============================================================================
 * Vanill-IA OS — Debian System Settings Control Panel (i18n EN/FR Live Reactive)
 * Sections:
 *  1. System Overview & Power
 *  2. Storage (lsblk / mount /mnt/) & Samba Shares
 *  3. Network, Tailscale VPN & Caddy Guard
 *  4. UFW Firewall & Fail2ban Jails
 *  5. Systemd Services & Journalctl (+ AI Diagnostics)
 *  6. APT Package Updates
 *  7. General, Language (`en`/`fr`), Appearance & 2FA TOTP
 * ==============================================================================
 */

import { renderQrCodeSvg } from '../core/QrCode.js';
import { t, getLanguage, setLanguage } from '../i18n.js';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / (1024 ** i)).toFixed(i >= 3 ? 2 : 1)} ${units[i]}`;
}

export async function mountApp({ container, api, params }) {
  let activeSection = params?.section || 'security';

  const renderShell = () => {
    container.innerHTML = `
      <div class="module-layout">
        <aside class="module-sidebar">
          <button type="button" class="module-nav-btn ${activeSection === 'security' ? 'active' : ''}" data-sec="security">🌐 ${escapeHtml(t('settings.nav_security'))}</button>
          <button type="button" class="module-nav-btn ${activeSection === 'overview' ? 'active' : ''}" data-sec="overview">🖥️ ${escapeHtml(t('settings.nav_overview'))}</button>
          <button type="button" class="module-nav-btn ${activeSection === 'storage' ? 'active' : ''}" data-sec="storage">💾 ${escapeHtml(t('settings.nav_storage'))}</button>
          <button type="button" class="module-nav-btn ${activeSection === 'network' ? 'active' : ''}" data-sec="network">🔗 ${escapeHtml(t('settings.nav_network'))}</button>
          <button type="button" class="module-nav-btn ${activeSection === 'firewall' ? 'active' : ''}" data-sec="firewall">🛡️ ${escapeHtml(t('settings.nav_firewall'))}</button>
          <button type="button" class="module-nav-btn ${activeSection === 'services' ? 'active' : ''}" data-sec="services">⚙️ ${escapeHtml(t('settings.nav_services'))}</button>
          <button type="button" class="module-nav-btn ${activeSection === 'apt' ? 'active' : ''}" data-sec="apt">📦 ${escapeHtml(t('settings.nav_apt'))}</button>
        </aside>
        <div class="module-content" id="sysSettingsPane"></div>
      </div>
      <div id="sysSettingsModal"></div>
    `;

    container.querySelectorAll('[data-sec]').forEach((btn) => {
      btn.addEventListener('click', () => switchSection(btn.dataset.sec));
    });
  };

  const notify = (msg, type = 'info') => window.__VANILLIA_DESKTOP__?.toast(msg, type);

  const switchSection = async (sec) => {
    activeSection = sec;
    container.querySelectorAll('[data-sec]').forEach((b) => {
      b.classList.toggle('active', b.dataset.sec === sec);
    });
    const pane = container.querySelector('#sysSettingsPane');
    if (!pane) return;
    pane.innerHTML = `<div class="settings-card">${escapeHtml(t('common.loading'))}</div>`;

    if (sec === 'overview') await renderOverview(pane);
    else if (sec === 'storage') await renderStorage(pane);
    else if (sec === 'network') await renderNetwork(pane);
    else if (sec === 'firewall') await renderFirewall(pane);
    else if (sec === 'services') await renderServices(pane);
    else if (sec === 'apt') await renderApt(pane);
    else if (sec === 'security') await renderSecurityAndAppearance(pane);
  };

  const onLangChanged = () => {
    renderShell();
    switchSection(activeSection);
  };
  window.addEventListener('vanillia:lang-changed', onLangChanged);

  // ==========================================================================
  // 1. SYSTEM OVERVIEW & POWER
  // ==========================================================================

  async function renderOverview(pane) {
    try {
      const info = await api.get('/api/system.php?action=info');
      const d = Math.floor((info.uptime_sec || 0) / 86400);
      const h = Math.floor(((info.uptime_sec || 0) % 86400) / 3600);
      const m = Math.floor(((info.uptime_sec || 0) % 3600) / 60);

      pane.innerHTML = `
        <div class="settings-card">
          <h3>${escapeHtml(t('settings.sys_hw_title'))}</h3>
          <p class="desc">${escapeHtml(t('settings.sys_hw_desc'))}</p>

          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;">
            <div class="kpi-card">
              <div class="kpi-label">${escapeHtml(t('settings.hostname'))}</div>
              <div class="kpi-value" style="font-size:1.1rem;">${escapeHtml(info.hostname)}</div>
              <div class="kpi-sub">${escapeHtml((info.ip_addresses || []).join(', ') || '127.0.0.1')}</div>
            </div>
            <div class="kpi-card">
              <div class="kpi-label">${escapeHtml(t('settings.distro'))}</div>
              <div class="kpi-value" style="font-size:1.02rem;">${escapeHtml(info.os_name)}</div>
              <div class="kpi-sub">Kernel ${escapeHtml(info.kernel)} (${escapeHtml(info.arch)})</div>
            </div>
            <div class="kpi-card">
              <div class="kpi-label">${escapeHtml(t('settings.cpu_mem'))}</div>
              <div class="kpi-value" style="font-size:1.02rem;">${info.cpu_cores} ${escapeHtml(t('settings.cores'))} · ${formatBytes(info.memory_total)}</div>
              <div class="kpi-sub">${escapeHtml(info.cpu_model)}</div>
            </div>
            <div class="kpi-card">
              <div class="kpi-label">${escapeHtml(t('settings.runtime'))}</div>
              <div class="kpi-value" style="font-size:1.02rem;">PHP ${escapeHtml(info.php_version)}${info.php_fpm_service ? ` (${escapeHtml(info.php_fpm_service)})` : ''}</div>
              <div class="kpi-sub">Uptime ${d}d ${h}h ${m}m · Caddy ${escapeHtml(info.caddy_version || 'Active')}</div>
            </div>
          </div>
        </div>

        <div class="settings-card">
          <h3>${escapeHtml(t('settings.power_card_title'))}</h3>
          <p class="desc">${escapeHtml(t('settings.power_card_desc'))}</p>
          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            <button type="button" class="os-btn os-btn-ghost" data-pwr="reboot">↻ ${escapeHtml(t('power.reboot'))}</button>
            <button type="button" class="os-btn os-btn-ghost" data-pwr="poweroff" style="color:var(--os-danger);">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>
              ${escapeHtml(t('power.poweroff'))}
            </button>
          </div>
        </div>
      `;

      pane.querySelectorAll('[data-pwr]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const mode = btn.dataset.pwr;
          if (!window.confirm(t(mode === 'reboot' ? 'power.confirm_reboot' : 'power.confirm_poweroff'))) return;
          try {
            await api.post('/api/system.php?action=power', { mode });
            if (mode === 'reboot') window.location.href = '/offline.html';
          } catch (err) {
            notify(err.message, 'error');
          }
        });
      });
    } catch (err) {
      pane.innerHTML = `<div class="os-alert os-alert-error">${escapeHtml(err.message)}</div>`;
    }
  }

  // ==========================================================================
  // 2. STORAGE (LSBLK, MOUNT /MNT/) & SAMBA SHARES
  // ==========================================================================

  async function renderStorage(pane) {
    try {
      const data = await api.get('/api/system.php?action=storage_overview');
      const devices = data.blockdevices || [];
      const shares = Array.isArray(data.samba?.shares) ? [...data.samba.shares] : [];

      const renderBlockRows = (list, depth = 0) => list.map((b) => {
        const canMount = b.fstype && !b.mountpoint && b.type !== 'disk';
        const canUmount = b.mountpoint && String(b.mountpoint).startsWith('/mnt/');
        return `
          <tr>
            <td style="padding-left:${13 + depth * 20}px;font-family:var(--font-mono);font-weight:${depth === 0 ? '700' : '400'};">
              ${depth > 0 ? '└─ ' : ''}${escapeHtml(b.name)}
            </td>
            <td>${escapeHtml(b.type)}</td>
            <td style="font-family:var(--font-mono);">${formatBytes(b.size)}</td>
            <td>${escapeHtml(b.fstype || '—')}</td>
            <td style="font-family:var(--font-mono);">${escapeHtml(b.mountpoint || '—')}</td>
            <td style="text-align:right;">
              ${canMount ? `<button type="button" class="btn-xs primary" data-mount-dev="${escapeHtml(b.path || '/dev/' + b.name)}" data-sug="${escapeHtml(b.label || b.name)}">${escapeHtml(t('settings.mount_in_mnt'))}</button>` : ''}
              ${canUmount ? `<button type="button" class="btn-xs danger" data-umount="${escapeHtml(b.mountpoint)}">${escapeHtml(t('settings.unmount'))}</button>` : ''}
            </td>
          </tr>
          ${Array.isArray(b.children) ? renderBlockRows(b.children, depth + 1) : ''}
        `;
      }).join('');

      pane.innerHTML = `
        <div class="settings-card">
          <h3>${escapeHtml(t('settings.storage_lsblk_title'))}</h3>
          <p class="desc">${escapeHtml(t('settings.storage_lsblk_desc'))}</p>
          ${devices.length === 0 ? `<p class="desc" style="margin:0;">No block devices reported (Linux daemon required).</p>` : `
            <div class="clean-table-wrap">
              <table class="clean-table">
                <thead>
                  <tr><th>Device</th><th>Type</th><th>Capacity</th><th>FS</th><th>Mountpoint</th><th></th></tr>
                </thead>
                <tbody>${renderBlockRows(devices)}</tbody>
              </table>
            </div>
          `}
        </div>

        <div class="settings-card">
          <div class="toolbar-row" style="margin-bottom:10px;">
            <div>
              <h3 style="margin:0;">${escapeHtml(t('settings.smb_title'))}</h3>
              <p class="desc" style="margin:2px 0 0;">${data.samba?.installed ? 'Samba installed' : 'samba package not installed'}</p>
            </div>
            <button type="button" class="btn-xs primary" id="createSmbShareBtn">${escapeHtml(t('settings.smb_new'))}</button>
          </div>

          <div id="smbSharesList" style="display:flex;flex-direction:column;gap:10px;"></div>
          <div style="margin-top:12px;">
            <button type="button" class="os-btn os-btn-primary" id="saveSmbBtn" style="width:auto;">${escapeHtml(t('settings.smb_save'))}</button>
          </div>
        </div>
      `;

      pane.querySelectorAll('[data-mount-dev]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const folder = window.prompt('/mnt/<folder>:', (btn.dataset.sug || 'data').replace(/[^a-zA-Z0-9_-]/g, ''));
          if (!folder) return;
          try {
            await api.post('/api/system.php?action=storage_mount', { source: btn.dataset.mountDev, folder });
            notify(`Mounted on /mnt/${folder}`);
            await renderStorage(pane);
          } catch (err) {
            notify(err.message, 'error');
          }
        });
      });

      pane.querySelectorAll('[data-umount]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const mp = btn.dataset.umount;
          if (!window.confirm(`Unmount ${mp}?`)) return;
          try {
            await api.post('/api/system.php?action=storage_umount', { mountpoint: mp });
            notify(`Unmounted ${mp}.`);
            await renderStorage(pane);
          } catch (err) {
            notify(err.message, 'error');
          }
        });
      });

      const smbContainer = pane.querySelector('#smbSharesList');
      const paintShares = () => {
        if (shares.length === 0) {
          smbContainer.innerHTML = `<div style="font-size:0.82rem;color:var(--os-text-secondary);">No Samba shares configured.</div>`;
          return;
        }
        smbContainer.innerHTML = shares.map((s, idx) => `
          <div style="display:grid;grid-template-columns:150px 1fr auto auto auto;gap:8px;align-items:center;padding:10px;border-radius:12px;background:rgba(0,0,0,0.14);border:1px solid var(--os-border);">
            <input type="text" class="os-input" data-sidx="${idx}" data-sfield="name" value="${escapeHtml(s.name)}" placeholder="ShareName" style="padding:7px 10px;">
            <input type="text" class="os-input" data-sidx="${idx}" data-sfield="path" value="${escapeHtml(s.path)}" placeholder="/mnt/disk" style="padding:7px 10px;font-family:var(--font-mono);">
            <label style="font-size:0.76rem;display:flex;align-items:center;gap:5px;"><input type="checkbox" data-sidx="${idx}" data-sfield="read_only" ${s.read_only ? 'checked' : ''}> Read-only</label>
            <label style="font-size:0.76rem;display:flex;align-items:center;gap:5px;"><input type="checkbox" data-sidx="${idx}" data-sfield="guest_ok" ${s.guest_ok ? 'checked' : ''}> Guest OK</label>
            <button type="button" class="btn-xs danger" data-del-smb="${idx}">✕</button>
          </div>
        `).join('');

        smbContainer.querySelectorAll('[data-sfield]').forEach((inp) => {
          inp.addEventListener('input', () => {
            const i = Number(inp.dataset.sidx);
            const f = inp.dataset.sfield;
            shares[i][f] = inp.type === 'checkbox' ? inp.checked : inp.value;
          });
        });

        smbContainer.querySelectorAll('[data-del-smb]').forEach((btn) => {
          btn.addEventListener('click', () => {
            shares.splice(Number(btn.dataset.delSmb), 1);
            paintShares();
          });
        });
      };

      paintShares();

      pane.querySelector('#createSmbShareBtn').addEventListener('click', () => {
        shares.push({ name: 'Media', path: '/mnt/media', read_only: false, guest_ok: false, browseable: true });
        paintShares();
      });

      pane.querySelector('#saveSmbBtn').addEventListener('click', async () => {
        try {
          await api.post('/api/system.php?action=samba_save', { shares });
          notify('Samba shares updated and smbd reloaded.');
        } catch (err) {
          notify(err.message, 'error');
        }
      });
    } catch (err) {
      pane.innerHTML = `<div class="os-alert os-alert-error">${escapeHtml(err.message)}</div>`;
    }
  }

  // ==========================================================================
  // 3. NETWORK, TAILSCALE & CADDY GUARD
  // ==========================================================================

  async function renderNetwork(pane) {
    try {
      const data = await api.get('/api/system.php?action=network_security');
      const ifaces = data.network?.interfaces || [];
      const dns = data.network?.nameservers || [];
      const ts = data.tailscale || {};
      const osState = window.__VANILLIA_DESKTOP__?.state?.os || {};

      pane.innerHTML = `
        <div class="settings-card">
          <h3>${escapeHtml(t('settings.tailscale_title'))}</h3>
          ${!ts.installed ? `<p class="desc" style="margin:0;">Tailscale is not installed (<code>curl -fsSL https://tailscale.com/install.sh | sh</code>).</p>` : `
            <p class="desc">State: <strong>${escapeHtml(ts.backend_state)}</strong> · IPs: <code>${escapeHtml((ts.tailscale_ips || []).join(', ') || '—')}</code> · Peers: ${ts.peers_count || 0}</p>
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
              <input type="text" class="os-input" id="tsAuthKey" placeholder="tskey-auth-... (optional)" style="max-width:290px;">
              <button type="button" class="btn-xs primary" id="tsUpBtn">Connect (tailscale up)</button>
              <button type="button" class="btn-xs danger" id="tsDownBtn">Disconnect</button>
            </div>
          `}
        </div>

        <div class="settings-card">
          <h3>${escapeHtml(t('settings.exposure_title'))}</h3>
          <p class="desc">${escapeHtml(t('settings.exposure_desc'))}</p>
          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            <select class="os-select" id="netExposureSel" style="max-width:350px;">
              <option value="all" ${osState.network_exposure === 'all' ? 'selected' : ''}>${escapeHtml(t('settings.exposure_all'))}</option>
              <option value="lan_tailscale" ${osState.network_exposure === 'lan_tailscale' ? 'selected' : ''}>${escapeHtml(t('settings.exposure_lan'))}</option>
              <option value="tailscale_only" ${osState.network_exposure === 'tailscale_only' ? 'selected' : ''}>${escapeHtml(t('settings.exposure_ts'))}</option>
            </select>
            <button type="button" class="os-btn os-btn-primary" id="applyExposureBtn" style="width:auto;">${escapeHtml(t('settings.exposure_apply'))}</button>
          </div>
        </div>

        <div class="settings-card">
          <h3>${escapeHtml(t('settings.net_ifaces_title', { count: ifaces.length }))}</h3>
          <p class="desc">${escapeHtml(t('settings.net_dns'))} <code>${escapeHtml(dns.join(', ') || 'System')}</code></p>

          <div class="cards-grid">
            ${ifaces.filter((i) => i.ifname !== 'lo').map((iface) => {
              const addrs = (iface.addr_info || []).map((a) => `${a.local}/${a.prefixlen}`).join(', ');
              return `
                <div class="entity-card">
                  <div style="display:flex;justify-content:space-between;">
                    <strong>${escapeHtml(iface.ifname)}</strong>
                    <span class="status-pill-sm ${iface.operstate === 'UP' ? 'status-running' : 'status-stopped'}">${escapeHtml(iface.operstate || 'UNKNOWN')}</span>
                  </div>
                  <div style="font-family:var(--font-mono);font-size:0.76rem;color:var(--os-text-secondary);">MAC: ${escapeHtml(iface.address || '—')}</div>
                  <div style="font-family:var(--font-mono);font-size:0.78rem;">${escapeHtml(addrs || 'No IP assigned')}</div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;

      pane.querySelector('#tsUpBtn')?.addEventListener('click', async () => {
        try {
          await api.post('/api/system.php?action=tailscale_action', {
            subcommand: 'up',
            authkey: pane.querySelector('#tsAuthKey')?.value || '',
          });
          notify('Tailscale connected.');
          await renderNetwork(pane);
        } catch (err) {
          notify(err.message, 'error');
        }
      });

      pane.querySelector('#tsDownBtn')?.addEventListener('click', async () => {
        try {
          await api.post('/api/system.php?action=tailscale_action', { subcommand: 'down' });
          notify('Tailscale disconnected.');
          await renderNetwork(pane);
        } catch (err) {
          notify(err.message, 'error');
        }
      });

      pane.querySelector('#applyExposureBtn')?.addEventListener('click', async () => {
        const mode = pane.querySelector('#netExposureSel').value;
        try {
          await api.post('/api/system.php?action=network_exposure', { mode });
          if (window.__VANILLIA_DESKTOP__?.state?.os) {
            window.__VANILLIA_DESKTOP__.state.os.network_exposure = mode;
          }
          notify('Caddy network isolation updated.');
        } catch (err) {
          notify(err.message, 'error');
        }
      });
    } catch (err) {
      pane.innerHTML = `<div class="os-alert os-alert-error">${escapeHtml(err.message)}</div>`;
    }
  }

  // ==========================================================================
  // 4. UFW FIREWALL & FAIL2BAN
  // ==========================================================================

  async function renderFirewall(pane) {
    try {
      const data = await api.get('/api/system.php?action=network_security');
      const ufw = data.ufw || {};
      const f2b = data.fail2ban || {};

      pane.innerHTML = `
        <div class="settings-card">
          <div class="toolbar-row" style="margin-bottom:12px;">
            <div>
              <h3 style="margin:0;">${escapeHtml(t('settings.ufw_title'))}</h3>
              <p class="desc" style="margin:2px 0 0;">${escapeHtml(t('settings.ufw_desc'))}</p>
            </div>
            <button type="button" class="btn-xs ${ufw.active ? 'danger' : 'primary'}" id="toggleUfwBtn">
              ${ufw.active ? 'Disable UFW' : 'Enable UFW Firewall'}
            </button>
          </div>

          <form id="ufwRuleForm" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">
            <select class="os-select" name="operation" style="max-width:140px;">
              <option value="allow">ALLOW</option>
              <option value="deny">DENY</option>
              <option value="limit">LIMIT</option>
            </select>
            <input type="text" class="os-input" name="port" placeholder="Port e.g. 443 or 8000:8010" required style="max-width:210px;">
            <select class="os-select" name="proto" style="max-width:120px;">
              <option value="tcp">TCP</option>
              <option value="udp">UDP</option>
              <option value="any">TCP+UDP</option>
            </select>
            <button type="submit" class="btn-xs primary">+ Add Rule</button>
          </form>

          ${(ufw.rules || []).length === 0 ? `<div style="font-size:0.82rem;color:var(--os-text-secondary);">No active UFW rules.</div>` : `
            <div class="clean-table-wrap">
              <table class="clean-table">
                <thead>
                  <tr><th>#</th><th>To</th><th>Action</th><th>From</th><th></th></tr>
                </thead>
                <tbody>
                  ${ufw.rules.map((r) => `
                    <tr>
                      <td style="font-family:var(--font-mono);">${r.number}</td>
                      <td style="font-family:var(--font-mono);font-weight:600;">${escapeHtml(r.to)}</td>
                      <td><span class="status-pill-sm ${r.action.includes('ALLOW') ? 'status-running' : 'status-error'}">${escapeHtml(r.action)}</span></td>
                      <td style="font-family:var(--font-mono);">${escapeHtml(r.from)}</td>
                      <td style="text-align:right;"><button type="button" class="btn-xs danger" data-del-ufw="${r.number}">${escapeHtml(t('common.delete'))}</button></td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          `}
        </div>

        <div class="settings-card">
          <h3>${escapeHtml(t('settings.f2b_title'))}</h3>
          <p class="desc">Monitors <code>/var/log/vanill-ia-auth.log</code> (<code>vanill-ia-os</code> jail) and SSH.</p>

          ${!f2b.running ? `<div style="font-size:0.82rem;color:var(--os-text-secondary);">Fail2ban service not running or not installed.</div>` : `
            <div class="cards-grid">
              ${(f2b.jails || []).map((j) => `
                <div class="entity-card">
                  <div style="display:flex;justify-content:space-between;">
                    <strong>Jail: ${escapeHtml(j.name)}</strong>
                    <span class="status-pill-sm ${j.currently_banned > 0 ? 'status-error' : 'status-running'}">${j.currently_banned} banned</span>
                  </div>
                  <div style="font-size:0.76rem;color:var(--os-text-secondary);">Total banned: ${j.total_banned}</div>
                  ${(j.banned_ips || []).length > 0 ? `
                    <div style="display:flex;flex-wrap:wrap;gap:6px;">
                      ${j.banned_ips.map((ip) => `
                        <button type="button" class="btn-xs danger" data-unban-ip="${escapeHtml(ip)}" data-unban-jail="${escapeHtml(j.name)}">
                          Unban ${escapeHtml(ip)} ✕
                        </button>
                      `).join('')}
                    </div>
                  ` : `<div style="font-size:0.76rem;color:var(--os-text-muted);">No currently banned IPs.</div>`}
                </div>
              `).join('')}
            </div>
          `}
        </div>
      `;

      pane.querySelector('#toggleUfwBtn').addEventListener('click', async () => {
        try {
          await api.post('/api/system.php?action=ufw_toggle', { enable: !ufw.active });
          await renderFirewall(pane);
        } catch (err) {
          notify(err.message, 'error');
        }
      });

      pane.querySelector('#ufwRuleForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        try {
          await api.post('/api/system.php?action=ufw_rule', {
            operation: fd.get('operation'),
            port: fd.get('port'),
            proto: fd.get('proto'),
          });
          await renderFirewall(pane);
        } catch (err) {
          notify(err.message, 'error');
        }
      });

      pane.querySelectorAll('[data-del-ufw]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await api.post('/api/system.php?action=ufw_rule', {
              operation: 'delete',
              number: Number(btn.dataset.delUfw),
            });
            await renderFirewall(pane);
          } catch (err) {
            notify(err.message, 'error');
          }
        });
      });

      pane.querySelectorAll('[data-unban-ip]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await api.post('/api/system.php?action=fail2ban_unban', {
              jail: btn.dataset.unbanJail,
              ip: btn.dataset.unbanIp,
            });
            await renderFirewall(pane);
          } catch (err) {
            notify(err.message, 'error');
          }
        });
      });
    } catch (err) {
      pane.innerHTML = `<div class="os-alert os-alert-error">${escapeHtml(err.message)}</div>`;
    }
  }

  // ==========================================================================
  // 5. SYSTEMD SERVICES & JOURNALCTL
  // ==========================================================================

  async function renderServices(pane, filterText = '', onlyFailed = false) {
    const modalSlot = container.querySelector('#sysSettingsModal');
    try {
      const res = await api.get(`/api/system.php?action=services_list&search=${encodeURIComponent(filterText)}`);
      let services = res.services || [];
      if (onlyFailed) {
        services = services.filter((s) => s.active === 'failed' || s.sub === 'failed');
      }

      pane.innerHTML = `
        <div class="toolbar-row">
          <div style="display:flex;gap:8px;flex:1;flex-wrap:wrap;">
            <input type="search" class="os-input" id="svcSearchInput" value="${escapeHtml(filterText)}" placeholder="${escapeHtml(t('settings.svc_search_ph'))}" style="max-width:310px;padding:7px 12px;">
            <label style="display:flex;align-items:center;gap:6px;font-size:0.82rem;cursor:pointer;">
              <input type="checkbox" id="svcOnlyFailed" ${onlyFailed ? 'checked' : ''}>
              ${escapeHtml(t('settings.svc_only_failed'))}
            </label>
          </div>
          <button type="button" class="btn-xs" id="svcRefreshBtn">↻ ${escapeHtml(t('common.refresh'))}</button>
        </div>

        <div class="clean-table-wrap">
          <table class="clean-table">
            <thead>
              <tr><th>Systemd Unit</th><th>State</th><th>Description</th><th style="text-align:right;">Actions</th></tr>
            </thead>
            <tbody>
              ${services.length === 0 ? `<tr><td colspan="4" style="text-align:center;color:var(--os-text-secondary);padding:20px;">No services found.</td></tr>` : services.slice(0, 120).map((s) => {
                const isRunning = s.active === 'active';
                const isFailed = s.active === 'failed';
                return `
                  <tr>
                    <td style="font-family:var(--font-mono);font-weight:600;">${escapeHtml(s.unit)}</td>
                    <td>
                      <span class="status-pill-sm ${isRunning ? 'status-running' : isFailed ? 'status-error' : 'status-stopped'}">
                        ${escapeHtml(s.active)} (${escapeHtml(s.sub)})
                      </span>
                    </td>
                    <td style="color:var(--os-text-secondary);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(s.description)}</td>
                    <td style="text-align:right;white-space:nowrap;">
                      <button type="button" class="btn-xs" data-unit="${escapeHtml(s.unit)}" data-uop="restart">↻</button>
                      ${isRunning
                        ? `<button type="button" class="btn-xs" data-unit="${escapeHtml(s.unit)}" data-uop="stop">⏹</button>`
                        : `<button type="button" class="btn-xs primary" data-unit="${escapeHtml(s.unit)}" data-uop="start">▶</button>`
                      }
                      <button type="button" class="btn-xs" data-svc-logs="${escapeHtml(s.unit)}">Logs</button>
                      <button type="button" class="btn-xs ai-diag" data-svc-ai="${escapeHtml(s.unit)}">✨ ${escapeHtml(t('common.ai_short'))}</button>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;

      const searchInp = pane.querySelector('#svcSearchInput');
      const failChk = pane.querySelector('#svcOnlyFailed');

      searchInp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') renderServices(pane, searchInp.value, failChk.checked);
      });
      failChk.addEventListener('change', () => renderServices(pane, searchInp.value, failChk.checked));
      pane.querySelector('#svcRefreshBtn').addEventListener('click', () => renderServices(pane, searchInp.value, failChk.checked));

      pane.querySelectorAll('[data-uop]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await api.post('/api/system.php?action=service_action', {
              unit: btn.dataset.unit,
              operation: btn.dataset.uop,
            });
            await renderServices(pane, searchInp.value, failChk.checked);
          } catch (err) {
            notify(err.message, 'error');
          }
        });
      });

      pane.querySelectorAll('[data-svc-logs]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const unit = btn.dataset.svcLogs;
          try {
            const resLogs = await api.get(`/api/system.php?action=service_logs&unit=${encodeURIComponent(unit)}&lines=180`);
            modalSlot.innerHTML = `
              <div class="inwin-modal-backdrop">
                <div class="inwin-modal">
                  <div class="inwin-modal-header">
                    <span>journalctl — ${escapeHtml(unit)}</span>
                    <div style="display:flex;gap:8px;">
                      <button type="button" class="btn-xs ai-diag" id="diagSvcModalBtn">✨ ${escapeHtml(t('common.ai_diagnose'))}</button>
                      <button type="button" class="btn-xs" id="closeSvcModalBtn">${escapeHtml(t('common.close'))}</button>
                    </div>
                  </div>
                  <div class="inwin-modal-body">
                    <pre class="log-console selectable">${escapeHtml(resLogs.logs || '(Empty)')}</pre>
                  </div>
                </div>
              </div>
            `;
            modalSlot.querySelector('#closeSvcModalBtn').addEventListener('click', () => { modalSlot.innerHTML = ''; });
            modalSlot.querySelector('#diagSvcModalBtn').addEventListener('click', () => {
              modalSlot.innerHTML = '';
              window.__VANILLIA_DESKTOP__?.launchAppById('vanill-ia-chat', {
                context_type: 'systemd_diag',
                target: unit,
                logs: resLogs.logs || '',
              });
            });
          } catch (err) {
            notify(err.message, 'error');
          }
        });
      });

      pane.querySelectorAll('[data-svc-ai]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const unit = btn.dataset.svcAi;
          const resLogs = await api.get(`/api/system.php?action=service_logs&unit=${encodeURIComponent(unit)}&lines=120`);
          window.__VANILLIA_DESKTOP__?.launchAppById('vanill-ia-chat', {
            context_type: 'systemd_diag',
            target: unit,
            logs: resLogs.logs || '',
          });
        });
      });
    } catch (err) {
      pane.innerHTML = `<div class="os-alert os-alert-error">${escapeHtml(err.message)}</div>`;
    }
  }

  // ==========================================================================
  // 6. APT PACKAGE UPDATES
  // ==========================================================================

  async function renderApt(pane, refresh = false) {
    if (refresh) {
      pane.innerHTML = `<div class="settings-card">Running <code>apt-get update</code>...</div>`;
    }
    try {
      const data = await api.get(`/api/system.php?action=apt_status${refresh ? '&refresh=1' : ''}`);
      const pkgs = data.packages || [];

      pane.innerHTML = `
        ${data.reboot_required ? `<div class="os-alert os-alert-info">⚠️ A recent kernel update requires a system reboot (<code>/var/run/reboot-required</code>).</div>` : ''}

        <div class="settings-card">
          <div class="toolbar-row">
            <div>
              <h3 style="margin:0;">${escapeHtml(t('settings.apt_title', { count: pkgs.length }))}</h3>
            </div>
            <div style="display:flex;gap:8px;">
              <button type="button" class="btn-xs" id="aptRefreshBtn">🔍 ${escapeHtml(t('settings.apt_check'))}</button>
              ${pkgs.length > 0 ? `<button type="button" class="btn-xs primary" id="aptUpgradeBtn">⬆️ ${escapeHtml(t('settings.apt_upgrade_all', { count: pkgs.length }))}</button>` : ''}
            </div>
          </div>

          ${pkgs.length === 0 ? `<p style="margin-top:14px;font-size:0.84rem;color:var(--os-success);font-weight:600;">${escapeHtml(t('settings.apt_up_to_date'))}</p>` : `
            <div class="clean-table-wrap" style="margin-top:14px;">
              <table class="clean-table">
                <thead>
                  <tr><th>Package</th><th>Current</th><th>New</th><th>Suite / Arch</th></tr>
                </thead>
                <tbody>
                  ${pkgs.map((p) => `
                    <tr>
                      <td style="font-family:var(--font-mono);font-weight:600;">${escapeHtml(p.name)}</td>
                      <td style="font-family:var(--font-mono);color:var(--os-text-secondary);">${escapeHtml(p.current_version)}</td>
                      <td style="font-family:var(--font-mono);color:var(--os-success);font-weight:600;">${escapeHtml(p.new_version)}</td>
                      <td>${escapeHtml(p.suite)} (${escapeHtml(p.arch)})</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          `}

          <pre class="log-console hidden selectable" id="aptUpgradeConsole" style="margin-top:14px;"></pre>
        </div>
      `;

      pane.querySelector('#aptRefreshBtn').addEventListener('click', () => renderApt(pane, true));
      pane.querySelector('#aptUpgradeBtn')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        if (!window.confirm(`Upgrade ${pkgs.length} packages now?`)) return;
        btn.disabled = true;
        const out = pane.querySelector('#aptUpgradeConsole');
        out.classList.remove('hidden');
        out.textContent = 'Running apt-get upgrade...';
        try {
          const res = await api.post('/api/system.php?action=apt_upgrade');
          out.textContent = res.output || 'Upgrade completed.';
          notify('Debian packages upgraded!');
        } catch (err) {
          out.textContent = `[ERROR] ${err.message}`;
          notify(err.message, 'error');
          btn.disabled = false;
        }
      });
    } catch (err) {
      pane.innerHTML = `<div class="os-alert os-alert-error">${escapeHtml(err.message)}</div>`;
    }
  }

  // ==========================================================================
  // 7. GENERAL, LANGUAGE (`en` / `fr`), APPEARANCE & 2FA TOTP
  // ==========================================================================

  async function renderSecurityAndAppearance(pane) {
    const user = window.__VANILLIA_DESKTOP__?.state?.user || {};
    const currentLang = getLanguage();
    let auditLogs = [];
    try {
      const aRes = await api.get('/api/system.php?action=audit_logs');
      auditLogs = aRes.logs || [];
    } catch (_) {}

    const wallpapers = [
      { id: 'aurora-coral', label: 'Aurora Coral', bg: 'linear-gradient(135deg, #FF6D5A 0%, #1E293B 60%, #0EA5E9 100%)' },
      { id: 'midnight-slate', label: 'Midnight Slate', bg: 'linear-gradient(135deg, #0F172A 0%, #2563EB 100%)' },
      { id: 'twilight', label: 'Twilight', bg: 'linear-gradient(135deg, #7C3AED 0%, #EC4899 100%)' },
      { id: 'emerald-abyss', label: 'Emerald Abyss', bg: 'linear-gradient(135deg, #064E3B 0%, #14B8A6 100%)' },
      { id: 'solar-sand', label: 'Solar Sand', bg: 'linear-gradient(135deg, #F59E0B 0%, #FF6D5A 100%)' },
    ];

    pane.innerHTML = `
      <div class="settings-card">
        <h3>${escapeHtml(t('settings.appearance_title'))}</h3>
        <p class="desc">${escapeHtml(t('settings.appearance_desc'))}</p>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(195px,1fr));gap:12px;margin-bottom:16px;">
          <div>
            <label class="form-label">${escapeHtml(t('settings.language_field'))}</label>
            <select class="os-select" id="secLangSelect">
              <option value="en" ${currentLang === 'en' ? 'selected' : ''}>English</option>
              <option value="fr" ${currentLang === 'fr' ? 'selected' : ''}>Français</option>
            </select>
          </div>
          <div>
            <label class="form-label">${escapeHtml(t('settings.theme_field'))}</label>
            <select class="os-select" id="secThemeMode">
              <option value="dark" ${user.theme_mode === 'dark' ? 'selected' : ''}>${escapeHtml(t('settings.theme_dark'))}</option>
              <option value="light" ${user.theme_mode === 'light' ? 'selected' : ''}>${escapeHtml(t('settings.theme_light'))}</option>
            </select>
          </div>
          <div>
            <label class="form-label">${escapeHtml(t('settings.autolock_field'))}</label>
            <select class="os-select" id="secLockMin">
              <option value="5" ${user.session_lock_minutes === 5 ? 'selected' : ''}>${escapeHtml(t('settings.lock_5m'))}</option>
              <option value="15" ${user.session_lock_minutes === 15 ? 'selected' : ''}>${escapeHtml(t('settings.lock_15m'))}</option>
              <option value="30" ${user.session_lock_minutes === 30 ? 'selected' : ''}>${escapeHtml(t('settings.lock_30m'))}</option>
              <option value="60" ${user.session_lock_minutes === 60 ? 'selected' : ''}>${escapeHtml(t('settings.lock_60m'))}</option>
              <option value="0" ${user.session_lock_minutes === 0 ? 'selected' : ''}>${escapeHtml(t('settings.lock_never'))}</option>
            </select>
          </div>
        </div>

        <label class="form-label">${escapeHtml(t('settings.wallpaper_field'))}</label>
        <div class="wallpaper-swatches">
          ${wallpapers.map((w) => `
            <button type="button" class="wp-swatch ${user.wallpaper === w.id ? 'active' : ''}" data-wp-pick="${w.id}" style="background:${w.bg}">
              ${w.label}
            </button>
          `).join('')}
        </div>
      </div>

      <div class="settings-card">
        <h3>${escapeHtml(t('settings.totp_title'))}</h3>
        <p class="desc">${escapeHtml(t('settings.totp_desc'))}</p>
        <div id="secTotpBox"></div>
      </div>

      <div class="settings-card">
        <h3>${escapeHtml(t('settings.audit_title', { count: auditLogs.length }))}</h3>
        <div class="clean-table-wrap" style="margin-top:8px;max-height:240px;overflow-y:auto;">
          <table class="clean-table">
            <thead>
              <tr><th>UTC Timestamp</th><th>User</th><th>IP</th><th>Action</th><th>Target</th></tr>
            </thead>
            <tbody>
              ${auditLogs.map((l) => `
                <tr>
                  <td style="font-family:var(--font-mono);font-size:0.74rem;">${escapeHtml(l.created_at)}</td>
                  <td>${escapeHtml(l.username)}</td>
                  <td style="font-family:var(--font-mono);">${escapeHtml(l.ip_address || '')}</td>
                  <td><span class="status-pill-sm status-info">${escapeHtml(l.action)}</span></td>
                  <td style="font-family:var(--font-mono);font-size:0.75rem;">${escapeHtml(l.target || '—')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    const savePrefs = async (patch) => {
      try {
        const res = await api.post('/api/settings.php?action=preferences', patch);
        window.__VANILLIA_DESKTOP__?.applyUserPreferences(res.user);
        notify(t('settings.prefs_saved'));
      } catch (err) {
        notify(err.message, 'error');
      }
    };

    // Immediate persistent language switch without closing any open windows
    pane.querySelector('#secLangSelect').addEventListener('change', async (e) => {
      const nextLang = e.target.value;
      try {
        const res = await api.post('/api/settings.php?action=language', { language: nextLang });
        if (window.__VANILLIA_DESKTOP__?.state?.user) {
          window.__VANILLIA_DESKTOP__.state.user.language = nextLang;
        }
        setLanguage(nextLang);
        if (res.user) {
          window.__VANILLIA_DESKTOP__?.applyUserPreferences(res.user);
        }
        notify(t('settings.prefs_saved'));
      } catch (err) {
        notify(err.message, 'error');
      }
    });

    pane.querySelector('#secThemeMode').addEventListener('change', (e) => savePrefs({ theme_mode: e.target.value }));
    pane.querySelector('#secLockMin').addEventListener('change', (e) => savePrefs({ session_lock_minutes: Number(e.target.value) }));
    pane.querySelectorAll('[data-wp-pick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        pane.querySelectorAll('[data-wp-pick]').forEach((b) => b.classList.toggle('active', b === btn));
        savePrefs({ wallpaper: btn.dataset.wpPick });
      });
    });

    const totpBox = pane.querySelector('#secTotpBox');
    const paintTotp = () => {
      const isEnabled = Boolean(window.__VANILLIA_DESKTOP__?.state?.user?.totp_enabled);
      if (isEnabled) {
        totpBox.innerHTML = `
          <div class="os-alert os-alert-info">${escapeHtml(t('settings.totp_active_msg'))}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <input type="password" class="os-input" id="disPass" placeholder="${escapeHtml(t('settings.current_password'))}" style="max-width:210px;">
            <input type="text" class="os-input code-totp" id="disCode" placeholder="${escapeHtml(t('settings.totp_code_ph'))}" maxlength="9" style="max-width:160px;">
            <button type="button" class="btn-xs danger" id="disBtn">${escapeHtml(t('settings.totp_disable_btn'))}</button>
          </div>
        `;
        totpBox.querySelector('#disBtn').addEventListener('click', async () => {
          try {
            await api.post('/api/auth.php?action=totp_disable', {
              password: totpBox.querySelector('#disPass').value,
              totp_code: totpBox.querySelector('#disCode').value,
            });
            window.__VANILLIA_DESKTOP__.state.user.totp_enabled = false;
            paintTotp();
          } catch (err) {
            notify(err.message, 'error');
          }
        });
      } else {
        totpBox.innerHTML = `<button type="button" class="os-btn os-btn-primary" id="enStartBtn" style="width:auto;">${escapeHtml(t('settings.totp_enable_btn'))}</button>`;
        totpBox.querySelector('#enStartBtn').addEventListener('click', async () => {
          const prep = await api.post('/api/auth.php?action=totp_prepare');
          totpBox.innerHTML = `
            <div class="totp-setup-box">
              <div class="qr-frame">${renderQrCodeSvg(prep.otpauth_uri)}</div>
              <p style="text-align:center;font-family:var(--font-mono);font-size:0.76rem;margin-bottom:10px;" class="selectable">${escapeHtml(t('auth.secret_label'))}: ${prep.secret}</p>
              <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;">
                <input type="password" class="os-input" id="enPass" placeholder="${escapeHtml(t('auth.password'))}" style="max-width:200px;">
                <input type="text" class="os-input code-totp" id="enCode" placeholder="000000" maxlength="6" style="max-width:150px;">
                <button type="button" class="os-btn os-btn-primary" id="enConfirmBtn" style="width:auto;">${escapeHtml(t('settings.totp_confirm_btn'))}</button>
              </div>
            </div>
          `;
          totpBox.querySelector('#enConfirmBtn').addEventListener('click', async () => {
            try {
              const res = await api.post('/api/auth.php?action=totp_enable', {
                password: totpBox.querySelector('#enPass').value,
                totp_code: totpBox.querySelector('#enCode').value,
              });
              window.__VANILLIA_DESKTOP__.state.user.totp_enabled = true;
              totpBox.innerHTML = `
                <div class="os-alert os-alert-info"><strong>${escapeHtml(t('settings.totp_enabled_msg'))}</strong></div>
                <div class="backup-codes-grid selectable">${res.backup_codes.map((c) => `<div class="backup-code-chip">${c}</div>`).join('')}</div>
              `;
            } catch (err) {
              notify(err.message, 'error');
            }
          });
        });
      }
    };
    paintTotp();
  }

  renderShell();
  await switchSection(activeSection);

  return {
    cleanup() {
      window.removeEventListener('vanillia:lang-changed', onLangChanged);
    },
    onLaunch(newParams) {
      if (newParams?.section) switchSection(newParams.section);
    },
  };
}
