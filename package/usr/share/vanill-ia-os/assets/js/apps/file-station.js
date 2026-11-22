/**
 * ==============================================================================
 * Vanill-IA OS — Files Explorer & Public Share Manager (`file-station.js`)
 * - Breadcrumb navigation + Quick Bookmarks (i18n EN/FR reactive)
 * - Drag & Drop Multi-File Upload + Direct Download
 * - Public File Sharing ("Mini-WeTransfer" via `/share.php`) + Shared Links Tab
 * - Zip / Unzip Archives + Chmod / Chown Permissions Modal
 * - Media Preview (Images, PDF, Video, Audio) + Direct Launch in Code Editor
 * ==============================================================================
 */

import { t } from '../i18n.js';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n === 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

const TEXT_EXTS = new Set([
  'txt', 'md', 'yml', 'yaml', 'json', 'xml', 'php', 'js', 'mjs', 'ts', 'css', 'html',
  'sh', 'bash', 'zsh', 'py', 'conf', 'caddy', 'ini', 'env', 'sql', 'log', 'service', 'local', 'toml',
]);
const IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
const VIDEO_EXTS = new Set(['mp4', 'webm']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg']);

function getFileEmoji(item) {
  if (item.is_dir) return '📁';
  const ext = item.extension || '';
  if (IMG_EXTS.has(ext)) return '🖼️';
  if (ext === 'pdf') return '📕';
  if (VIDEO_EXTS.has(ext)) return '🎬';
  if (AUDIO_EXTS.has(ext)) return '🎵';
  if (ext === 'zip' || ext === 'tar' || ext === 'gz') return '🗜️';
  if (TEXT_EXTS.has(ext) || item.name.startsWith('.')) return '📄';
  return '📦';
}

export async function mountApp({ container, api, params }) {
  let activeView = params?.view === 'shares' ? 'shares' : 'explorer';
  let currentPath = params?.path || '/opt/vanill-ia/stacks';
  let items = [];
  let sharesList = [];
  let showHidden = false;
  let searchFilter = '';

  const getBookmarks = () => [
    { label: `🏠 ${t('files.root')}`, path: '/' },
    { label: `🐳 ${t('files.stacks')}`, path: '/opt/vanill-ia/stacks' },
    { label: `💾 ${t('files.mnt')}`, path: '/mnt' },
    { label: `🔒 ${t('files.caddy')}`, path: '/etc/caddy/conf.d' },
    { label: `📝 ${t('files.notes')}`, path: '/var/lib/vanill-ia-os/notes' },
    { label: `📜 ${t('files.logs')}`, path: '/var/log' },
    { label: '👤 /root', path: '/root' },
  ];

  const notify = (msg, typeOrOpts = 'info') => window.__VANILLIA_DESKTOP__?.notify(msg, typeOrOpts);

  const renderShell = () => {
    const activeCount = sharesList.filter((s) => s.status === 'active').length;

    container.innerHTML = `
      <div class="module-layout" id="fsDropZone">
        <aside class="module-sidebar" id="fsSidebar">
          <div style="font-size:0.72rem;font-weight:700;color:var(--os-text-muted);padding:4px 10px;text-transform:uppercase;">${escapeHtml(t('files.locations'))}</div>
          ${getBookmarks().map((b) => `
            <button type="button" class="module-nav-btn ${activeView === 'explorer' && b.path === currentPath ? 'active' : ''}" data-bm="${escapeHtml(b.path)}">${escapeHtml(b.label)}</button>
          `).join('')}

          <div style="height:1px;background:var(--os-border);margin:8px 4px;"></div>
          <button type="button" class="module-nav-btn ${activeView === 'shares' ? 'active' : ''}" id="fsSharesNavBtn">
            <span>🔗 ${escapeHtml(t('shares.nav_label'))}</span>
            <span class="status-pill-sm status-info" id="fsSharesCountBadge">${activeCount}</span>
          </button>
        </aside>
        <div class="module-content" id="fsContent"></div>
      </div>
      <input type="file" id="fsUploadInput" multiple class="hidden">
      <div id="fsModalSlot"></div>
    `;

    container.querySelectorAll('[data-bm]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeView = 'explorer';
        navigate(btn.dataset.bm);
      });
    });

    container.querySelector('#fsSharesNavBtn')?.addEventListener('click', () => {
      activeView = 'shares';
      loadSharesView();
    });

    const dropZone = container.querySelector('#fsDropZone');
    const uploadInput = container.querySelector('#fsUploadInput');

    dropZone.addEventListener('dragover', (e) => {
      if (activeView !== 'explorer') return;
      e.preventDefault();
      dropZone.style.outline = '2px dashed var(--os-accent)';
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.style.outline = 'none';
    });
    dropZone.addEventListener('drop', async (e) => {
      if (activeView !== 'explorer') return;
      e.preventDefault();
      dropZone.style.outline = 'none';
      if (e.dataTransfer?.files?.length) {
        await uploadFiles(e.dataTransfer.files);
      }
    });

    uploadInput.addEventListener('change', async () => {
      if (uploadInput.files?.length) {
        await uploadFiles(uploadInput.files);
        uploadInput.value = '';
      }
    });
  };

  async function refreshSharesBadge() {
    try {
      const res = await api.get('/api/shares.php');
      sharesList = res.shares || [];
      const badge = container.querySelector('#fsSharesCountBadge');
      if (badge) {
        badge.textContent = String(sharesList.filter((s) => s.status === 'active').length);
      }
    } catch (_) {}
  }

  async function uploadFiles(fileList) {
    const fd = new FormData();
    fd.append('dir', currentPath);
    for (const f of fileList) {
      fd.append('files[]', f);
    }
    try {
      const res = await api.post('/api/files.php?action=upload', fd);
      const count = (res.uploaded || []).length;
      notify(t('files.upload_complete_msg', { count, path: currentPath }), {
        level: 'success',
        persist: true,
        title: t('files.upload_complete_title', { count }),
        source: 'files',
        actionPayload: { app: 'file-station', path: currentPath },
      });
      await navigate(currentPath);
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  async function navigate(targetPath) {
    activeView = 'explorer';
    const contentEl = container.querySelector('#fsContent');
    try {
      const res = await api.get(`/api/files.php?action=list&path=${encodeURIComponent(targetPath)}${showHidden ? '&hidden=1' : ''}`);
      currentPath = res.path || targetPath;
      items = res.items || [];

      container.querySelectorAll('[data-bm]').forEach((b) => {
        b.classList.toggle('active', b.dataset.bm === currentPath);
      });
      container.querySelector('#fsSharesNavBtn')?.classList.remove('active');

      renderExplorer();
    } catch (err) {
      if (targetPath !== '/') {
        await navigate('/');
      } else if (contentEl) {
        contentEl.innerHTML = `<div class="os-alert os-alert-error">${escapeHtml(err.message)}</div>`;
      }
    }
  }

  function buildBreadcrumbsHtml(pathStr) {
    const parts = pathStr.split('/').filter(Boolean);
    let acc = '';
    let html = `<button type="button" class="btn-xs" data-crumb="/">/</button>`;
    for (const part of parts) {
      acc += '/' + part;
      html += `<span style="color:var(--os-text-muted);">›</span><button type="button" class="btn-xs" data-crumb="${escapeHtml(acc)}">${escapeHtml(part)}</button>`;
    }
    return html;
  }

  function renderExplorer() {
    const contentEl = container.querySelector('#fsContent');
    const uploadInput = container.querySelector('#fsUploadInput');
    if (!contentEl) return;

    const filtered = items.filter((it) => searchFilter === '' || it.name.toLowerCase().includes(searchFilter));

    contentEl.innerHTML = `
      <div class="toolbar-row">
        <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
          ${buildBreadcrumbsHtml(currentPath)}
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button type="button" class="btn-xs primary" id="fsBtnUpload">⬆️ ${escapeHtml(t('files.upload'))}</button>
          <button type="button" class="btn-xs" id="fsBtnNewFolder">${escapeHtml(t('files.new_folder'))}</button>
          <button type="button" class="btn-xs" id="fsBtnNewFile">${escapeHtml(t('files.new_file'))}</button>
          <label class="btn-xs" style="cursor:pointer;">
            <input type="checkbox" id="fsChkHidden" ${showHidden ? 'checked' : ''}> ${escapeHtml(t('files.hidden'))}
          </label>
          <button type="button" class="btn-xs" id="fsBtnRefresh">↻</button>
        </div>
      </div>

      <div class="toolbar-row">
        <input type="search" class="os-input" id="fsFilterInp" value="${escapeHtml(searchFilter)}" placeholder="${escapeHtml(t('files.filter_ph'))}" style="max-width:280px;padding:7px 12px;font-size:0.82rem;">
        <span style="font-size:0.76rem;color:var(--os-text-secondary);">${escapeHtml(t('files.items_count', { count: filtered.length }))}</span>
      </div>

      <div class="clean-table-wrap">
        <table class="clean-table">
          <thead>
            <tr>
              <th>${escapeHtml(t('files.col_name'))}</th>
              <th>${escapeHtml(t('files.col_size'))}</th>
              <th>${escapeHtml(t('files.col_perms'))}</th>
              <th>${escapeHtml(t('files.col_owner'))}</th>
              <th style="text-align:right;">${escapeHtml(t('files.col_actions'))}</th>
            </tr>
          </thead>
          <tbody>
            ${currentPath !== '/' ? `
              <tr style="cursor:pointer;" id="fsParentRow">
                <td colspan="5" style="font-weight:600;color:var(--os-text-secondary);">${escapeHtml(t('files.parent_dir'))}</td>
              </tr>
            ` : ''}
            ${filtered.length === 0 ? `<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--os-text-secondary);">${escapeHtml(t('files.empty_dir'))}</td></tr>` : filtered.map((it, idx) => `
              <tr data-item-idx="${idx}" style="cursor:pointer;">
                <td data-open-row="${idx}">
                  <span style="margin-right:8px;">${getFileEmoji(it)}</span>
                  <strong style="font-weight:${it.is_dir ? '600' : '500'};">${escapeHtml(it.name)}</strong>
                  ${it.is_symlink ? `<span class="status-pill-sm status-info" style="margin-left:6px;">link</span>` : ''}
                </td>
                <td style="font-family:var(--font-mono);font-size:0.77rem;">${it.is_dir ? '—' : formatBytes(it.size)}</td>
                <td style="font-family:var(--font-mono);font-size:0.76rem;color:var(--os-text-secondary);">${escapeHtml(it.mode)}</td>
                <td style="font-family:var(--font-mono);font-size:0.76rem;color:var(--os-text-secondary);">${escapeHtml(it.owner)}:${escapeHtml(it.group)}</td>
                <td style="text-align:right;white-space:nowrap;">
                  ${!it.is_dir ? `
                    <button type="button" class="btn-xs primary" data-fs-act="share" data-idx="${idx}" title="${escapeHtml(t('shares.share_btn'))}">🔗 ${escapeHtml(t('shares.share_btn'))}</button>
                    <a href="/api/files.php?action=download&path=${encodeURIComponent(it.path)}" class="btn-xs" style="text-decoration:none;" title="${escapeHtml(t('common.download'))}">⬇️</a>
                  ` : ''}
                  ${it.extension === 'zip'
                    ? `<button type="button" class="btn-xs" data-fs-act="unzip" data-idx="${idx}">📦 ${escapeHtml(t('files.extract'))}</button>`
                    : `<button type="button" class="btn-xs" data-fs-act="zip" data-idx="${idx}">🗜️ ${escapeHtml(t('files.zip'))}</button>`
                  }
                  <button type="button" class="btn-xs" data-fs-act="perms" data-idx="${idx}" title="chmod / chown">🔐</button>
                  <button type="button" class="btn-xs" data-fs-act="rename" data-idx="${idx}" title="${escapeHtml(t('common.rename'))}">✎</button>
                  <button type="button" class="btn-xs danger" data-fs-act="delete" data-idx="${idx}" title="${escapeHtml(t('common.delete'))}">✕</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    contentEl.querySelectorAll('[data-crumb]').forEach((b) => {
      b.addEventListener('click', () => navigate(b.dataset.crumb));
    });

    contentEl.querySelector('#fsParentRow')?.addEventListener('click', () => {
      const parent = currentPath.substring(0, currentPath.lastIndexOf('/')) || '/';
      navigate(parent);
    });

    contentEl.querySelector('#fsBtnUpload').addEventListener('click', () => uploadInput?.click());
    contentEl.querySelector('#fsBtnRefresh').addEventListener('click', () => navigate(currentPath));
    contentEl.querySelector('#fsChkHidden').addEventListener('change', (e) => {
      showHidden = e.target.checked;
      navigate(currentPath);
    });

    const filterInp = contentEl.querySelector('#fsFilterInp');
    filterInp.addEventListener('input', () => {
      searchFilter = filterInp.value.toLowerCase();
      renderExplorer();
      const nf = contentEl.querySelector('#fsFilterInp');
      nf?.focus();
      nf?.setSelectionRange(nf.value.length, nf.value.length);
    });

    contentEl.querySelector('#fsBtnNewFolder').addEventListener('click', async () => {
      const name = window.prompt('Folder name:');
      if (!name) return;
      try {
        const target = (currentPath === '/' ? '' : currentPath) + '/' + name.trim();
        await api.post('/api/files.php?action=mkdir', { path: target });
        await navigate(currentPath);
      } catch (err) {
        notify(err.message, 'error');
      }
    });

    contentEl.querySelector('#fsBtnNewFile').addEventListener('click', async () => {
      const name = window.prompt('File name (e.g. script.sh or config.yml):');
      if (!name) return;
      const target = (currentPath === '/' ? '' : currentPath) + '/' + name.trim();
      try {
        await api.post('/api/files.php?action=write', { path: target, content: '' });
        await navigate(currentPath);
        window.__VANILLIA_DESKTOP__?.launchAppById('code-editor', { path: target });
      } catch (err) {
        notify(err.message, 'error');
      }
    });

    contentEl.querySelectorAll('[data-open-row]').forEach((cell) => {
      cell.addEventListener('click', () => {
        const it = filtered[Number(cell.dataset.openRow)];
        if (!it) return;
        if (it.is_dir) {
          navigate(it.path);
          return;
        }
        const ext = it.extension || '';
        if (IMG_EXTS.has(ext) || ext === 'pdf' || VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext)) {
          openMediaPreviewModal(it);
          return;
        }
        window.__VANILLIA_DESKTOP__?.launchAppById('code-editor', { path: it.path });
      });
    });

    contentEl.querySelectorAll('[data-fs-act]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const it = filtered[Number(btn.dataset.idx)];
        if (!it) return;
        const act = btn.dataset.fsAct;

        if (act === 'share') {
          openCreateShareModal(it);
        } else if (act === 'rename') {
          const nextName = window.prompt(t('common.rename') + ':', it.name);
          if (!nextName || nextName === it.name) return;
          const dest = (currentPath === '/' ? '' : currentPath) + '/' + nextName.trim();
          try {
            await api.post('/api/files.php?action=rename', { from: it.path, to: dest });
            await navigate(currentPath);
          } catch (err) {
            notify(err.message, 'error');
          }
        } else if (act === 'delete') {
          if (!window.confirm(`${t('common.delete')} "${it.name}"?`)) return;
          try {
            await api.post('/api/files.php?action=delete', { path: it.path });
            await navigate(currentPath);
          } catch (err) {
            notify(err.message, 'error');
          }
        } else if (act === 'zip') {
          try {
            await api.post('/api/files.php?action=archive', { mode: 'zip', source: it.path, destination: `${it.path}.zip` });
            await navigate(currentPath);
          } catch (err) {
            notify(err.message, 'error');
          }
        } else if (act === 'unzip') {
          try {
            await api.post('/api/files.php?action=archive', { mode: 'unzip', source: it.path, destination: currentPath });
            await navigate(currentPath);
          } catch (err) {
            notify(err.message, 'error');
          }
        } else if (act === 'perms') {
          openPermsModal(it);
        }
      });
    });
  }

  // ==========================================================================
  // PUBLIC FILE SHARING ("MINI-WETRANSFER") MODAL & MANAGEMENT VIEW
  // ==========================================================================

  function openCreateShareModal(item) {
    const modalSlot = container.querySelector('#fsModalSlot');
    modalSlot.innerHTML = `
      <div class="inwin-modal-backdrop">
        <div class="inwin-modal" style="max-width:480px;">
          <div class="inwin-modal-header">
            <span>🔗 ${escapeHtml(t('shares.modal_title'))} — ${escapeHtml(item.name)}</span>
            <button type="button" class="btn-xs" id="closeShareModalBtn">${escapeHtml(t('common.close'))}</button>
          </div>
          <div class="inwin-modal-body">
            <form id="createShareForm">
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                <div class="form-group">
                  <label class="form-label">${escapeHtml(t('shares.expiration_label'))}</label>
                  <select class="os-select" name="expires_in_seconds">
                    <option value="3600">${escapeHtml(t('shares.exp_1h'))}</option>
                    <option value="86400">${escapeHtml(t('shares.exp_24h'))}</option>
                    <option value="604800" selected>${escapeHtml(t('shares.exp_7d'))}</option>
                    <option value="2592000">${escapeHtml(t('shares.exp_30d'))}</option>
                    <option value="0">${escapeHtml(t('shares.exp_never'))}</option>
                  </select>
                </div>

                <div class="form-group">
                  <label class="form-label">${escapeHtml(t('shares.max_dl_label'))}</label>
                  <select class="os-select" name="max_downloads">
                    <option value="" selected>${escapeHtml(t('shares.max_unlimited'))}</option>
                    <option value="1">${escapeHtml(t('shares.max_1'))}</option>
                    <option value="5">${escapeHtml(t('shares.max_5'))}</option>
                    <option value="10">${escapeHtml(t('shares.max_10'))}</option>
                    <option value="25">${escapeHtml(t('shares.max_25'))}</option>
                  </select>
                </div>
              </div>

              <div class="form-group">
                <label class="form-label">${escapeHtml(t('shares.password_label'))}</label>
                <input type="password" class="os-input" name="password" placeholder="${escapeHtml(t('shares.password_ph'))}" autocomplete="new-password">
              </div>

              <button type="submit" class="os-btn os-btn-primary" id="genShareSubmitBtn">🔗 ${escapeHtml(t('shares.create_btn'))}</button>
            </form>

            <div id="shareResultBox" class="totp-setup-box hidden" style="margin-top:4px;">
              <div style="font-size:0.78rem;color:var(--os-text-secondary);margin-bottom:6px;">${escapeHtml(t('shares.generated_label'))}</div>
              <div style="display:flex;gap:8px;">
                <input type="text" class="os-input selectable" id="generatedShareUrlInp" readonly style="font-family:var(--font-mono);font-size:0.8rem;">
                <button type="button" class="os-btn os-btn-primary" id="copyGeneratedShareBtn" style="width:auto;white-space:nowrap;">📋 ${escapeHtml(t('shares.copy_link'))}</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    modalSlot.querySelector('#closeShareModalBtn').addEventListener('click', () => { modalSlot.innerHTML = ''; });

    modalSlot.querySelector('#createShareForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      const expSec = Number(fd.get('expires_in_seconds') || 0);
      const maxDlRaw = fd.get('max_downloads');

      try {
        const res = await api.post('/api/shares.php', {
          file_path: item.path,
          expires_in_seconds: expSec > 0 ? expSec : null,
          max_downloads: maxDlRaw ? Number(maxDlRaw) : null,
          password: fd.get('password') || '',
        });

        const canonicalShareUrl = `${window.location.origin}/share.php?t=${encodeURIComponent(res.token)}`;
        const box = modalSlot.querySelector('#shareResultBox');
        const inp = modalSlot.querySelector('#generatedShareUrlInp');
        const copyBtn = modalSlot.querySelector('#copyGeneratedShareBtn');

        box.classList.remove('hidden');
        inp.value = canonicalShareUrl;
        inp.select();

        copyBtn.onclick = async () => {
          await navigator.clipboard.writeText(canonicalShareUrl);
          copyBtn.textContent = `✓ ${t('common.copied')}`;
          setTimeout(() => { copyBtn.textContent = `📋 ${t('shares.copy_link')}`; }, 1600);
        };

        await refreshSharesBadge();
        notify(t('shares.created_toast'), { level: 'success' });
      } catch (err) {
        notify(err.message, 'error');
      }
    });
  }

  async function loadSharesView() {
    container.querySelectorAll('[data-bm]').forEach((b) => b.classList.remove('active'));
    container.querySelector('#fsSharesNavBtn')?.classList.add('active');

    const contentEl = container.querySelector('#fsContent');
    contentEl.innerHTML = `<div class="settings-card">${escapeHtml(t('common.loading'))}</div>`;

    try {
      const res = await api.get('/api/shares.php');
      sharesList = res.shares || [];
      const badge = container.querySelector('#fsSharesCountBadge');
      if (badge) {
        badge.textContent = String(sharesList.filter((s) => s.status === 'active').length);
      }

      contentEl.innerHTML = `
        <div class="settings-card" style="padding:15px 18px;">
          <div class="toolbar-row">
            <div>
              <h3 style="margin:0;">🔗 ${escapeHtml(t('shares.list_title', { count: sharesList.length }))}</h3>
              <p class="desc" style="margin:2px 0 0;">${escapeHtml(t('shares.list_desc'))}</p>
            </div>
            <button type="button" class="btn-xs" id="refreshSharesListBtn">↻ ${escapeHtml(t('common.refresh'))}</button>
          </div>
        </div>

        ${sharesList.length === 0 ? `
          <div class="settings-card" style="text-align:center;padding:30px;">
            <p class="desc" style="margin:0;">${escapeHtml(t('shares.empty_list'))}</p>
          </div>
        ` : `
          <div class="clean-table-wrap">
            <table class="clean-table">
              <thead>
                <tr>
                  <th>${escapeHtml(t('shares.col_file'))}</th>
                  <th>${escapeHtml(t('shares.col_status'))}</th>
                  <th>${escapeHtml(t('shares.col_downloads'))}</th>
                  <th>${escapeHtml(t('shares.col_expires'))}</th>
                  <th style="text-align:right;">${escapeHtml(t('files.col_actions'))}</th>
                </tr>
              </thead>
              <tbody>
                ${sharesList.map((s) => {
                  const statusClass = s.status === 'active' ? 'status-running' : s.status === 'expired' ? 'status-stopped' : 'status-error';
                  const statusLabel = s.status === 'active'
                    ? t('shares.status_active')
                    : s.status === 'expired'
                      ? t('shares.status_expired')
                      : t('shares.status_exhausted');
                  const expLabel = s.expires_at
                    ? new Date(s.expires_at * 1000).toLocaleString()
                    : '∞';
                  const dlLabel = `${s.download_count} / ${s.max_downloads ?? '∞'}`;
                  const canonicalRowUrl = `${window.location.origin}/share.php?t=${encodeURIComponent(s.token)}`;

                  return `
                    <tr>
                      <td>
                        <div style="font-weight:600;">
                          ${s.has_password ? '🔒 ' : '📄 '}${escapeHtml(s.file_name)}
                        </div>
                        <div style="font-family:var(--font-mono);font-size:0.72rem;color:var(--os-text-secondary);">${escapeHtml(s.file_path)} (${formatBytes(s.file_size)})</div>
                      </td>
                      <td><span class="status-pill-sm ${statusClass}">${escapeHtml(statusLabel)}</span></td>
                      <td style="font-family:var(--font-mono);">${escapeHtml(dlLabel)}</td>
                      <td style="font-family:var(--font-mono);font-size:0.76rem;">${escapeHtml(expLabel)}</td>
                      <td style="text-align:right;white-space:nowrap;">
                        <button type="button" class="btn-xs primary" data-copy-share="${escapeHtml(canonicalRowUrl)}">📋 ${escapeHtml(t('shares.copy_link'))}</button>
                        <a href="${escapeHtml(canonicalRowUrl)}" target="_blank" rel="noopener noreferrer" class="btn-xs" style="text-decoration:none;">↗</a>
                        <button type="button" class="btn-xs danger" data-revoke-share="${s.id}" data-revoke-name="${escapeHtml(s.file_name)}">✕ ${escapeHtml(t('shares.revoke_btn'))}</button>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        `}
      `;

      contentEl.querySelector('#refreshSharesListBtn')?.addEventListener('click', loadSharesView);

      contentEl.querySelectorAll('[data-copy-share]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          await navigator.clipboard.writeText(btn.dataset.copyShare);
          const orig = btn.textContent;
          btn.textContent = `✓ ${t('common.copied')}`;
          setTimeout(() => { btn.textContent = orig; }, 1400);
        });
      });

      contentEl.querySelectorAll('[data-revoke-share]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = Number(btn.dataset.revokeShare);
          const name = btn.dataset.revokeName;
          if (!window.confirm(t('shares.confirm_revoke', { name }))) return;
          try {
            await api.delete('/api/shares.php', { id });
            notify(t('shares.revoked_toast'));
            await loadSharesView();
          } catch (err) {
            notify(err.message, 'error');
          }
        });
      });
    } catch (err) {
      contentEl.innerHTML = `<div class="os-alert os-alert-error">${escapeHtml(err.message)}</div>`;
    }
  }

  function openMediaPreviewModal(item) {
    const modalSlot = container.querySelector('#fsModalSlot');
    const url = `/api/files.php?action=preview&path=${encodeURIComponent(item.path)}`;
    const ext = item.extension;
    let bodyHtml = '';

    if (IMG_EXTS.has(ext)) {
      bodyHtml = `<img src="${url}" alt="${escapeHtml(item.name)}" style="max-width:100%;max-height:65vh;margin:0 auto;border-radius:10px;object-fit:contain;">`;
    } else if (ext === 'pdf') {
      bodyHtml = `<iframe src="${url}" style="width:100%;height:68vh;border:none;border-radius:10px;background:#FFF;"></iframe>`;
    } else if (VIDEO_EXTS.has(ext)) {
      bodyHtml = `<video src="${url}" controls autoplay style="width:100%;max-height:65vh;border-radius:10px;background:#000;"></video>`;
    } else if (AUDIO_EXTS.has(ext)) {
      bodyHtml = `<audio src="${url}" controls autoplay style="width:100%;margin:20px 0;"></audio>`;
    }

    modalSlot.innerHTML = `
      <div class="inwin-modal-backdrop">
        <div class="inwin-modal">
          <div class="inwin-modal-header">
            <span>${escapeHtml(item.name)}</span>
            <div style="display:flex;gap:8px;">
              <button type="button" class="btn-xs" id="shareFromPreviewBtn">🔗 ${escapeHtml(t('shares.share_btn'))}</button>
              <a href="/api/files.php?action=download&path=${encodeURIComponent(item.path)}" class="btn-xs primary" style="text-decoration:none;">⬇️ ${escapeHtml(t('common.download'))}</a>
              <button type="button" class="btn-xs" id="closePrevModal">${escapeHtml(t('common.close'))}</button>
            </div>
          </div>
          <div class="inwin-modal-body">${bodyHtml}</div>
        </div>
      </div>
    `;
    modalSlot.querySelector('#closePrevModal').addEventListener('click', () => { modalSlot.innerHTML = ''; });
    modalSlot.querySelector('#shareFromPreviewBtn').addEventListener('click', () => openCreateShareModal(item));
  }

  function openPermsModal(item) {
    const modalSlot = container.querySelector('#fsModalSlot');
    modalSlot.innerHTML = `
      <div class="inwin-modal-backdrop">
        <div class="inwin-modal" style="max-width:440px;">
          <div class="inwin-modal-header">
            <span>🔐 UNIX Permissions — ${escapeHtml(item.name)}</span>
            <button type="button" class="btn-xs" id="closePermsModal">${escapeHtml(t('common.close'))}</button>
          </div>
          <div class="inwin-modal-body">
            <form id="permsForm">
              <div class="form-group">
                <label class="form-label">Octal Mode (chmod)</label>
                <input type="text" class="os-input" name="mode" value="${escapeHtml(item.mode)}" pattern="[0-7]{3,4}" required style="font-family:var(--font-mono);">
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                <div class="form-group">
                  <label class="form-label">Owner (chown)</label>
                  <input type="text" class="os-input" name="owner" value="${escapeHtml(item.owner)}" required>
                </div>
                <div class="form-group">
                  <label class="form-label">Group</label>
                  <input type="text" class="os-input" name="group" value="${escapeHtml(item.group)}">
                </div>
              </div>
              ${item.is_dir ? `
                <div class="form-group">
                  <label style="display:flex;align-items:center;gap:8px;font-size:0.83rem;cursor:pointer;">
                    <input type="checkbox" name="recursive"> Apply recursively (-R)
                  </label>
                </div>
              ` : ''}
              <button type="submit" class="os-btn os-btn-primary">${escapeHtml(t('common.apply'))}</button>
            </form>
          </div>
        </div>
      </div>
    `;

    modalSlot.querySelector('#closePermsModal').addEventListener('click', () => { modalSlot.innerHTML = ''; });
    modalSlot.querySelector('#permsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      const recursive = fd.get('recursive') === 'on';
      try {
        await api.post('/api/files.php?action=chmod', { path: item.path, mode: fd.get('mode'), recursive });
        await api.post('/api/files.php?action=chown', { path: item.path, owner: fd.get('owner'), group: fd.get('group'), recursive });
        modalSlot.innerHTML = '';
        await navigate(currentPath);
      } catch (err) {
        notify(err.message, 'error');
      }
    });
  }

  const onLangChanged = () => {
    renderShell();
    if (activeView === 'shares') {
      loadSharesView();
    } else {
      renderExplorer();
    }
  };
  window.addEventListener('vanillia:lang-changed', onLangChanged);

  renderShell();
  refreshSharesBadge();
  if (activeView === 'shares') {
    await loadSharesView();
  } else {
    await navigate(currentPath);
  }

  return {
    cleanup() {
      window.removeEventListener('vanillia:lang-changed', onLangChanged);
    },
    onLaunch(newParams) {
      if (newParams?.view === 'shares') {
        activeView = 'shares';
        loadSharesView();
      } else if (newParams?.path) {
        activeView = 'explorer';
        navigate(newParams.path);
      }
    },
  };
}
