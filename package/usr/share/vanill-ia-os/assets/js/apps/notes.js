/**
 * ==============================================================================
 * Vanill-IA OS — Plain-Text Markdown Notes (`notes.js`)
 * Saves directly as clean `.md` files in `/var/lib/vanill-ia-os/notes/`
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

export function renderMarkdownHtml(md) {
  let html = escapeHtml(md);

  // Blocs de code ```lang ... ```
  html = html.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre class="log-console selectable" style="margin:10px 0;"><code>${code.trimEnd()}</code></pre>`;
  });

  // Code inline `...`
  html = html.replace(/`([^`\n]+)`/g, '<code style="padding:2px 6px;border-radius:5px;background:rgba(255,255,255,0.09);font-family:var(--font-mono);font-size:0.83em;">$1</code>');

  // Titres H1..H3
  html = html.replace(/^### (.+)$/gm, '<h4 style="margin:12px 0 6px;font-size:0.96rem;">$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3 style="margin:14px 0 6px;font-size:1.08rem;color:var(--os-accent);">$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2 style="margin:6px 0 10px;font-size:1.28rem;">$1</h2>');

  // Gras & Italique
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

  // Listes à puces
  html = html.replace(/^- (.+)$/gm, '<li style="margin-left:18px;margin-bottom:4px;">$1</li>');

  // Sauts de paragraphes
  html = html.replace(/\n{2,}/g, '<br><br>');
  return html;
}

export async function mountApp({ container, api }) {
  let notes = [];
  let currentName = '';
  let currentContent = '';
  let viewMode = 'split'; // edit | split | preview
  let saveTimer = null;

  container.innerHTML = `
    <div class="module-layout">
      <aside class="module-sidebar">
        <button type="button" class="os-btn os-btn-primary" id="newNoteBtn" data-i18n="notes.new_note" style="padding:8px 12px;margin-bottom:8px;font-size:0.82rem;">${escapeHtml(t('notes.new_note'))}</button>
        <div id="notesSidebarList" style="display:flex;flex-direction:column;gap:4px;"></div>
      </aside>

      <div style="flex:1;display:flex;flex-direction:column;min-width:0;">
        <div class="toolbar-row" style="padding:10px 16px;border-bottom:1px solid var(--os-border);">
          <input type="text" class="os-input" id="noteTitleInp" data-i18n-placeholder="notes.title_ph" placeholder="${escapeHtml(t('notes.title_ph'))}" style="max-width:260px;padding:6px 11px;font-weight:600;">
          <div style="display:flex;gap:6px;align-items:center;">
            <span id="noteSaveState" style="font-size:0.75rem;color:var(--os-text-muted);margin-right:6px;">${escapeHtml(t('notes.synced'))}</span>
            <button type="button" class="btn-xs" data-vmode="edit" data-i18n="notes.mode_edit">${escapeHtml(t('notes.mode_edit'))}</button>
            <button type="button" class="btn-xs primary" data-vmode="split" data-i18n="notes.mode_split">${escapeHtml(t('notes.mode_split'))}</button>
            <button type="button" class="btn-xs" data-vmode="preview" data-i18n="notes.mode_preview">${escapeHtml(t('notes.mode_preview'))}</button>
            <button type="button" class="btn-xs danger" id="delNoteBtn">✕</button>
          </div>
        </div>

        <div id="noteWorkspace" style="flex:1;display:grid;grid-template-columns:1fr 1fr;min-height:0;">
          <textarea id="noteEditorArea" spellcheck="true" style="width:100%;height:100%;padding:18px;border:none;border-right:1px solid var(--os-border);outline:none;resize:none;background:transparent;color:var(--os-text);font-family:var(--font-mono);font-size:0.86rem;line-height:1.6;" placeholder="# Server Documentation..."></textarea>
          <div id="notePreviewPane" class="selectable" style="padding:18px 22px;overflow-y:auto;line-height:1.6;"></div>
        </div>
      </div>
    </div>
  `;

  const listEl = container.querySelector('#notesSidebarList');
  const titleInp = container.querySelector('#noteTitleInp');
  const editorArea = container.querySelector('#noteEditorArea');
  const previewPane = container.querySelector('#notePreviewPane');
  const workspace = container.querySelector('#noteWorkspace');
  const saveState = container.querySelector('#noteSaveState');
  const notify = (msg, type = 'info') => window.__VANILLIA_DESKTOP__?.toast(msg, type);

  async function refreshList(selectName = null) {
    const res = await api.get('/api/files.php?action=notes_list');
    notes = res.notes || [];

    listEl.innerHTML = notes.map((n) => `
      <button type="button" class="module-nav-btn ${n.name === (selectName || currentName) ? 'active' : ''}" data-note="${escapeHtml(n.name)}">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📝 ${escapeHtml(n.name)}</span>
      </button>
    `).join('');

    listEl.querySelectorAll('[data-note]').forEach((btn) => {
      btn.addEventListener('click', () => openNote(btn.dataset.note));
    });

    if (selectName) {
      await openNote(selectName);
    } else if (!currentName && notes.length > 0) {
      await openNote(notes[0].name);
    } else if (notes.length === 0) {
      currentName = 'Bienvenue';
      titleInp.value = 'Bienvenue';
      editorArea.value = '# Notes Serveur Debian\n\nVos notes sont sauvegardées en clair au format `.md`.';
      updatePreview();
    }
  }

  async function openNote(name) {
    try {
      const res = await api.get(`/api/files.php?action=note_get&name=${encodeURIComponent(name)}`);
      currentName = res.name;
      currentContent = res.content;
      titleInp.value = currentName;
      editorArea.value = currentContent;
      updatePreview();
      listEl.querySelectorAll('[data-note]').forEach((b) => b.classList.toggle('active', b.dataset.note === currentName));
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  function updatePreview() {
    previewPane.innerHTML = renderMarkdownHtml(editorArea.value);
  }

  async function saveNow() {
    const newName = titleInp.value.trim() || 'Sans-titre';
    saveState.textContent = 'Enregistrement...';
    try {
      const res = await api.post('/api/files.php?action=note_save', {
        name: newName,
        old_name: currentName,
        content: editorArea.value,
      });
      currentName = res.name;
      saveState.textContent = '✓ Enregistré';
      await refreshList();
    } catch (err) {
      saveState.textContent = 'Erreur';
      notify(err.message, 'error');
    }
  }

  function scheduleSave() {
    saveState.textContent = '● Modifié...';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 750);
  }

  editorArea.addEventListener('input', () => {
    updatePreview();
    scheduleSave();
  });
  titleInp.addEventListener('change', saveNow);

  container.querySelector('#newNoteBtn').addEventListener('click', async () => {
    const name = `Note-${new Date().toISOString().slice(0, 10)}-${Math.floor(Math.random() * 90 + 10)}`;
    currentName = '';
    titleInp.value = name;
    editorArea.value = `# ${name}\n\n`;
    updatePreview();
    await saveNow();
  });

  container.querySelector('#delNoteBtn').addEventListener('click', async () => {
    if (!currentName || !window.confirm(`Supprimer la note "${currentName}.md" ?`)) return;
    await api.post('/api/files.php?action=note_delete', { name: currentName });
    currentName = '';
    await refreshList();
  });

  container.querySelectorAll('[data-vmode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      viewMode = btn.dataset.vmode;
      container.querySelectorAll('[data-vmode]').forEach((b) => b.classList.toggle('primary', b === btn));
      if (viewMode === 'edit') {
        workspace.style.gridTemplateColumns = '1fr';
        editorArea.classList.remove('hidden');
        previewPane.classList.add('hidden');
      } else if (viewMode === 'preview') {
        workspace.style.gridTemplateColumns = '1fr';
        editorArea.classList.add('hidden');
        previewPane.classList.remove('hidden');
      } else {
        workspace.style.gridTemplateColumns = '1fr 1fr';
        editorArea.classList.remove('hidden');
        previewPane.classList.remove('hidden');
      }
    });
  });

  await refreshList();

  return {
    cleanup() {
      if (saveTimer) clearTimeout(saveTimer);
    },
  };
}
