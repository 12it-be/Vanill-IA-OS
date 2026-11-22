/**
 * ==============================================================================
 * Vanill-IA OS — Native SMB/CIFS Mount Manager (`mount-manager.js`)
 * - Secure SMB/CIFS mounting via `vanill-ia-agent` (ephemeral `/tmp/.smb-cred-XXXX`
 *   with `chmod 0600` unlinked immediately after `mount` — zero persistent secret)
 * - Automatic detection of `cifs-utils` (`mount.cifs`) with 1-click Copy &
 *   "Run in Terminal" (`sudo apt update && sudo apt install -y cifs-utils`)
 * - Lists active CIFS mounts (`findmnt -t cifs,smb3 -J`) with "Open in Files"
 * ==============================================================================
 */

import { t } from '../i18n.js';

const INSTALL_CIFS_CMD = 'sudo apt update && sudo apt install -y cifs-utils';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / (1024 ** i)).toFixed(i >= 3 ? 2 : 1)} ${units[i]}`;
}

export async function mountApp({ container, api }) {
  let state = {
    agent_online: false,
    cifs_installed: true,
    mounts: [],
  };

  let draft = {
    host: '',
    share: '',
    mountpoint: '/mnt/nas',
    mountpointTouched: false,
    username: '',
    domain: '',
    vers: 'auto',
    read_only: false,
  };

  container.innerHTML = `<div class="module-content" id="mountMainPane" style="height:100%;"></div>`;
  const pane = container.querySelector('#mountMainPane');
  const notify = (msg, type = 'info') => window.__VANILLIA_DESKTOP__?.toast(msg, type);

  async function loadStatus(silent = false) {
    if (!silent) {
      pane.innerHTML = `<div class="settings-card">${escapeHtml(t('common.loading'))}</div>`;
    }
    try {
      state = await api.get('/api/mount.php?action=status');
      render();
    } catch (err) {
      pane.innerHTML = `<div class="os-alert os-alert-error">${escapeHtml(err.message)}</div>`;
    }
  }

  function render() {
    const mounts = state.mounts || [];
    const showMissingBanner = state.agent_online && !state.cifs_installed;

    pane.innerHTML = `
      <div class="settings-card" style="padding:15px 18px;">
        <div class="toolbar-row">
          <div>
            <h3 style="margin:0;">💾 ${escapeHtml(t('mount.header_title'))}</h3>
            <p class="desc" style="margin:2px 0 0;">${escapeHtml(t('mount.header_desc'))}</p>
          </div>
          <button type="button" class="btn-xs" id="refreshMountStatusBtn">↻ ${escapeHtml(t('common.refresh'))}</button>
        </div>
      </div>

      ${!state.agent_online ? `
        <div class="os-alert os-alert-info">
          Daemon <code>vanill-ia-agent</code> is offline on this preview host. Deploy the <code>.deb</code> package on Debian 12/13 to mount live SMB/CIFS shares.
        </div>
      ` : ''}

      ${showMissingBanner ? `
        <div class="settings-card" style="border-color:rgba(245,158,11,0.5);background:rgba(245,158,11,0.08);">
          <h3 style="color:var(--os-warning);">⚠️ ${escapeHtml(t('mount.missing_cifs_title'))}</h3>
          <p class="desc" style="margin-bottom:10px;">${escapeHtml(t('mount.missing_cifs_desc'))}</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <code class="selectable" style="flex:1;min-width:240px;padding:9px 12px;border-radius:10px;background:#090B10;border:1px solid var(--os-border-strong);font-family:var(--font-mono);font-size:0.81rem;color:#F8FAFC;">${INSTALL_CIFS_CMD}</code>
            <button type="button" class="btn-xs" id="copyCifsCmdBtn">📋 ${escapeHtml(t('common.copy'))}</button>
            <button type="button" class="btn-xs primary" id="runTerminalCifsBtn">▶_ ${escapeHtml(t('mount.run_in_terminal'))}</button>
            <button type="button" class="btn-xs" id="recheckCifsBtn">↻ ${escapeHtml(t('mount.recheck_btn'))}</button>
          </div>
        </div>
      ` : ''}

      <form id="cifsMountForm" class="settings-card" autocomplete="off">
        <div class="toolbar-row" style="margin-bottom:12px;">
          <h3 style="margin:0;">${escapeHtml(t('mount.form_title'))}</h3>
          <span id="uncLiveBadge" style="font-family:var(--font-mono);font-size:0.77rem;color:var(--os-accent);">
            //${escapeHtml(draft.host || 'host')}/${escapeHtml(draft.share || 'share')} → ${escapeHtml(draft.mountpoint || '/mnt/nas')}
          </span>
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin-bottom:12px;">
          <div>
            <label class="form-label">${escapeHtml(t('mount.host_label'))}</label>
            <input type="text" class="os-input" name="host" id="smbHostInp" value="${escapeHtml(draft.host)}" placeholder="${escapeHtml(t('mount.host_ph'))}" required>
          </div>
          <div>
            <label class="form-label">${escapeHtml(t('mount.share_label'))}</label>
            <input type="text" class="os-input" name="share" id="smbShareInp" value="${escapeHtml(draft.share)}" placeholder="${escapeHtml(t('mount.share_ph'))}" required>
          </div>
          <div>
            <label class="form-label">${escapeHtml(t('mount.mountpoint_label'))}</label>
            <input type="text" class="os-input" name="mountpoint" id="smbMountInp" value="${escapeHtml(draft.mountpoint)}" placeholder="${escapeHtml(t('mount.mountpoint_ph'))}" pattern="^/mnt/[a-zA-Z0-9_-]{1,48}$" required style="font-family:var(--font-mono);">
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-bottom:12px;">
          <div>
            <label class="form-label">${escapeHtml(t('mount.username_label'))}</label>
            <input type="text" class="os-input" name="username" id="smbUserInp" value="${escapeHtml(draft.username)}" placeholder="${escapeHtml(t('mount.username_ph'))}" autocomplete="off">
          </div>
          <div>
            <label class="form-label">${escapeHtml(t('mount.password_label'))}</label>
            <input type="password" class="os-input" name="password" id="smbPassInp" placeholder="••••••••" autocomplete="new-password">
          </div>
          <div>
            <label class="form-label">${escapeHtml(t('mount.domain_label'))}</label>
            <input type="text" class="os-input" name="domain" id="smbDomainInp" value="${escapeHtml(draft.domain)}" placeholder="${escapeHtml(t('mount.domain_ph'))}">
          </div>
          <div>
            <label class="form-label">${escapeHtml(t('mount.version_label'))}</label>
            <select class="os-select" name="vers" id="smbVersSel">
              <option value="auto" ${draft.vers === 'auto' ? 'selected' : ''}>${escapeHtml(t('mount.vers_auto'))}</option>
              <option value="3.1.1" ${draft.vers === '3.1.1' ? 'selected' : ''}>SMB 3.1.1</option>
              <option value="3.0" ${draft.vers === '3.0' ? 'selected' : ''}>SMB 3.0</option>
              <option value="2.1" ${draft.vers === '2.1' ? 'selected' : ''}>SMB 2.1</option>
              <option value="2.0" ${draft.vers === '2.0' ? 'selected' : ''}>SMB 2.0</option>
            </select>
          </div>
        </div>

        <div class="toolbar-row" style="padding-top:6px;border-top:1px solid var(--os-border);">
          <div style="display:flex;flex-direction:column;gap:4px;">
            <label style="display:inline-flex;align-items:center;gap:7px;font-size:0.82rem;cursor:pointer;">
              <input type="checkbox" name="read_only" id="smbRoChk" ${draft.read_only ? 'checked' : ''}>
              ${escapeHtml(t('mount.read_only'))}
            </label>
            <span style="font-size:0.73rem;color:var(--os-text-muted);">🔒 ${escapeHtml(t('mount.zero_secret_badge'))}</span>
          </div>

          <button type="submit" class="os-btn os-btn-primary" id="smbSubmitBtn" style="width:auto;" ${showMissingBanner ? 'disabled style="width:auto;opacity:0.5;"' : ''}>
            🔌 ${escapeHtml(t('mount.mount_btn'))}
          </button>
        </div>
      </form>

      <div class="settings-card">
        <h3>${escapeHtml(t('mount.active_title', { count: mounts.length }))}</h3>

        ${mounts.length === 0 ? `
          <p class="desc" style="margin:8px 0 0;">${escapeHtml(t('mount.empty_mounts'))}</p>
        ` : `
          <div class="cards-grid" style="margin-top:12px;">
            ${mounts.map((m) => {
              const hasUsage = m.total_bytes !== null && m.total_bytes > 0;
              const pct = Number(m.used_percent || 0);
              return `
                <article class="entity-card">
                  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
                    <div style="min-width:0;">
                      <strong style="font-family:var(--font-mono);font-size:0.92rem;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                        ${escapeHtml(m.target)}
                      </strong>
                      <span style="font-family:var(--font-mono);font-size:0.76rem;color:var(--os-accent);">
                        ${escapeHtml(m.source)}
                      </span>
                    </div>
                    <span class="status-pill-sm status-running">${escapeHtml(m.fstype || 'cifs')}</span>
                  </div>

                  ${hasUsage ? `
                    <div>
                      <div style="display:flex;justify-content:space-between;font-size:0.74rem;font-family:var(--font-mono);margin-bottom:4px;">
                        <span>${formatBytes(m.used_bytes)} / ${formatBytes(m.total_bytes)}</span>
                        <span>${pct.toFixed(1)}%</span>
                      </div>
                      <div class="metric-bar" style="width:100%;height:6px;">
                        <span style="width:${Math.min(100, pct)}%;background:${pct > 88 ? 'var(--os-danger)' : 'var(--os-info)'}"></span>
                      </div>
                    </div>
                  ` : ''}

                  <div style="font-family:var(--font-mono);font-size:0.7rem;color:var(--os-text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(m.options)}">
                    ${escapeHtml(m.options)}
                  </div>

                  <div style="display:flex;gap:8px;margin-top:auto;padding-top:8px;border-top:1px solid var(--os-border);">
                    <button type="button" class="btn-xs primary" data-open-files="${escapeHtml(m.target)}">
                      📂 ${escapeHtml(t('mount.open_in_files'))}
                    </button>
                    <button type="button" class="btn-xs danger" data-umount-cifs="${escapeHtml(m.target)}" style="margin-left:auto;">
                      ⏏ ${escapeHtml(t('mount.unmount_btn'))}
                    </button>
                  </div>
                </article>
              `;
            }).join('')}
          </div>
        `}
      </div>
    `;

    bindEvents();
  }

  function bindEvents() {
    pane.querySelector('#refreshMountStatusBtn')?.addEventListener('click', () => loadStatus(false));
    pane.querySelector('#recheckCifsBtn')?.addEventListener('click', () => loadStatus(false));

    pane.querySelector('#copyCifsCmdBtn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      await navigator.clipboard.writeText(INSTALL_CIFS_CMD);
      btn.textContent = `✓ ${t('common.copied')}`;
      setTimeout(() => { btn.textContent = `📋 ${t('common.copy')}`; }, 1600);
    });

    pane.querySelector('#runTerminalCifsBtn')?.addEventListener('click', () => {
      window.__VANILLIA_DESKTOP__?.launchAppById('terminal', {
        runCommand: INSTALL_CIFS_CMD,
      });
    });

    const hostInp = pane.querySelector('#smbHostInp');
    const shareInp = pane.querySelector('#smbShareInp');
    const mountInp = pane.querySelector('#smbMountInp');
    const userInp = pane.querySelector('#smbUserInp');
    const passInp = pane.querySelector('#smbPassInp');
    const domInp = pane.querySelector('#smbDomainInp');
    const versSel = pane.querySelector('#smbVersSel');
    const roChk = pane.querySelector('#smbRoChk');
    const uncBadge = pane.querySelector('#uncLiveBadge');

    const updateLiveUnc = () => {
      draft.host = hostInp.value.trim();
      draft.share = shareInp.value.trim().replace(/^[/\\]+|[/\\]+$/g, '');
      if (!draft.mountpointTouched && draft.share) {
        const slug = draft.share.split('/')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
        if (slug) {
          mountInp.value = `/mnt/${slug.slice(0, 32)}`;
        }
      }
      draft.mountpoint = mountInp.value.trim();
      draft.username = userInp.value;
      draft.domain = domInp.value;
      draft.vers = versSel.value;
      draft.read_only = roChk.checked;

      uncBadge.textContent = `//${draft.host || 'host'}/${draft.share || 'share'} → ${draft.mountpoint || '/mnt/nas'}`;
    };

    hostInp.addEventListener('input', updateLiveUnc);
    shareInp.addEventListener('input', updateLiveUnc);
    mountInp.addEventListener('input', () => {
      draft.mountpointTouched = true;
      updateLiveUnc();
    });
    userInp.addEventListener('input', updateLiveUnc);
    domInp.addEventListener('input', updateLiveUnc);
    versSel.addEventListener('change', updateLiveUnc);
    roChk.addEventListener('change', updateLiveUnc);

    pane.querySelector('#cifsMountForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = pane.querySelector('#smbSubmitBtn');
      submitBtn.disabled = true;
      submitBtn.textContent = `⏳ ${t('mount.mounting')}`;

      const password = passInp.value;
      // Clear password field from DOM immediately on submit
      passInp.value = '';

      try {
        const res = await api.post('/api/mount.php?action=mount', {
          host: draft.host,
          share: draft.share,
          mountpoint: draft.mountpoint,
          username: draft.username.trim(),
          password,
          domain: draft.domain.trim(),
          vers: draft.vers,
          read_only: draft.read_only,
        });

        notify(t('mount.mounted_toast', { unc: `//${draft.host}/${draft.share}`, target: draft.mountpoint }));
        state.cifs_installed = Boolean(res.cifs_installed);
        state.mounts = res.mounts || [];
        draft.share = '';
        draft.mountpointTouched = false;
        render();
      } catch (err) {
        notify(err.message, 'error');
        if (err.code === 'CIFS_UTILS_MISSING') {
          state.cifs_installed = false;
        }
        render();
      }
    });

    // Open in Files
    pane.querySelectorAll('[data-open-files]').forEach((btn) => {
      btn.addEventListener('click', () => {
        window.__VANILLIA_DESKTOP__?.launchAppById('file-station', {
          path: btn.dataset.openFiles,
        });
      });
    });

    // Unmount share
    pane.querySelectorAll('[data-umount-cifs]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const target = btn.dataset.umountCifs;
        if (!window.confirm(t('mount.confirm_unmount', { target }))) return;
        btn.disabled = true;
        try {
          const res = await api.post('/api/mount.php?action=umount', { mountpoint: target });
          state.mounts = res.mounts || [];
          notify(t('mount.unmounted_toast', { target }));
          render();
        } catch (err) {
          notify(err.message, 'error');
          btn.disabled = false;
        }
      });
    });
  }

  const onLangChanged = () => render();
  window.addEventListener('vanillia:lang-changed', onLangChanged);

  await loadStatus();

  return {
    cleanup() {
      window.removeEventListener('vanillia:lang-changed', onLangChanged);
    },
  };
}
