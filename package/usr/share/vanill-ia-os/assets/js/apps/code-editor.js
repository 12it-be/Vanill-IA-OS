/**
 * ==============================================================================
 * Vanill-IA OS — Multi-Tab Code & Config Editor (`code-editor.js`)
 * Directly integrated with Files to edit YAML, Caddyfiles, PHP, Bash,
 * systemd units & configs with Ctrl+S save and synchronized syntax highlighting.
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

function highlightGenericCode(raw, ext) {
  return escapeHtml(raw)
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('--')) {
        return `<span class="yc">${line}</span>`;
      }
      let out = line;
      // Chaînes
      out = out.replace(/(&quot;[^&]*&quot;|'[^']*')/g, '<span class="ys">$1</span>');
      // Variables $VAR / ${VAR}
      out = out.replace(/(\$[a-zA-Z_][a-zA-Z0-9_]*|\$\{[^}]+\})/g, '<span class="yv">$1</span>');
      // Mots-clés courants multi-langages
      if (['php', 'js', 'sh', 'bash', 'sql'].includes(ext)) {
        out = out.replace(/\b(function|return|if|else|foreach|for|while|class|final|private|public|const|let|var|async|await|import|export|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|CREATE|TABLE)\b/g, '<span class="yk">$1</span>');
      } else {
        out = out.replace(/^(\s*-?\s*)([a-zA-Z0-9_.-]+)(:|\s+\{)/, '$1<span class="yk">$2</span>$3');
      }
      return out;
    })
    .join('\n') + '\n';
}

export async function mountApp({ container, api, params }) {
  const tabs = []; // { path, name, content, savedContent, ext }
  let activeIdx = -1;

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;">
      <div class="toolbar-row" style="padding:8px 14px;border-bottom:1px solid var(--os-border);background:rgba(0,0,0,0.18);">
        <div id="ceTabsBar" style="display:flex;gap:6px;overflow-x:auto;flex:1;"></div>
        <div style="display:flex;gap:6px;flex-shrink:0;">
          <button type="button" class="btn-xs" id="ceOpenPathBtn" data-i18n="editor.open_path">📂 Open Path...</button>
          <button type="button" class="btn-xs primary" id="ceSaveBtn" data-i18n="editor.save_btn">💾 Save (Ctrl+S)</button>
        </div>
      </div>

      <div class="yaml-editor-shell" style="flex:1;border-radius:0;border:none;">
        <div class="yaml-gutter" id="ceGutter">1</div>
        <div class="yaml-stage" id="ceStage">
          <pre class="yaml-highlight" id="ceHighlight" aria-hidden="true"></pre>
          <textarea class="yaml-textarea" id="ceTextarea" spellcheck="false" data-i18n-placeholder="editor.placeholder" placeholder="Open any file from Files or click 'Open Path...'"></textarea>
        </div>
      </div>

      <footer style="padding:5px 14px;border-top:1px solid var(--os-border);background:rgba(0,0,0,0.25);display:flex;justify-content:space-between;font-family:var(--font-mono);font-size:0.73rem;color:var(--os-text-secondary);">
        <span id="ceStatusPath">${escapeHtml(t('editor.no_file'))}</span>
        <span id="ceStatusMetrics">UTF-8 · LF</span>
      </footer>
    </div>
  `;

  const tabsBar = container.querySelector('#ceTabsBar');
  const gutter = container.querySelector('#ceGutter');
  const stage = container.querySelector('#ceStage');
  const highlight = container.querySelector('#ceHighlight');
  const textarea = container.querySelector('#ceTextarea');
  const statusPath = container.querySelector('#ceStatusPath');
  const statusMetrics = container.querySelector('#ceStatusMetrics');
  const notify = (msg, type = 'info') => window.__VANILLIA_DESKTOP__?.toast(msg, type);

  async function openFile(filePath) {
    const existing = tabs.findIndex((t) => t.path === filePath);
    if (existing !== -1) {
      activeIdx = existing;
      renderEditor();
      return;
    }

    try {
      const res = await api.get(`/api/files.php?action=read&path=${encodeURIComponent(filePath)}`);
      const name = filePath.split('/').pop() || filePath;
      const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
      tabs.push({
        path: res.path || filePath,
        name,
        content: res.content ?? '',
        savedContent: res.content ?? '',
        ext,
      });
      activeIdx = tabs.length - 1;
      renderEditor();
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  async function saveActiveTab() {
    const tab = tabs[activeIdx];
    if (!tab) {
      const target = window.prompt('Chemin complet où enregistrer ce nouveau fichier :', '/opt/vanill-ia/stacks/nouveau.yml');
      if (!target) return;
      tabs.push({
        path: target,
        name: target.split('/').pop(),
        content: textarea.value,
        savedContent: '',
        ext: target.split('.').pop() || '',
      });
      activeIdx = tabs.length - 1;
    }

    const active = tabs[activeIdx];
    try {
      await api.post('/api/files.php?action=write', {
        path: active.path,
        content: active.content,
      });
      active.savedContent = active.content;
      renderTabs();
      notify(`Enregistré : ${active.path}`);
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  function renderTabs() {
    tabsBar.innerHTML = tabs.map((t, i) => {
      const dirty = t.content !== t.savedContent;
      return `
        <div class="btn-xs ${i === activeIdx ? 'primary' : ''}" data-tab-idx="${i}" style="cursor:pointer;">
          <span>${dirty ? '● ' : ''}${escapeHtml(t.name)}</span>
          <span data-close-tab="${i}" style="margin-left:4px;opacity:0.75;">✕</span>
        </div>
      `;
    }).join('');

    tabsBar.querySelectorAll('[data-tab-idx]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.hasAttribute('data-close-tab')) {
          const cIdx = Number(e.target.dataset.closeTab);
          tabs.splice(cIdx, 1);
          activeIdx = Math.min(activeIdx, tabs.length - 1);
          renderEditor();
          return;
        }
        activeIdx = Number(el.dataset.tabIdx);
        renderEditor();
      });
    });
  }

  function syncHighlighting() {
    const tab = tabs[activeIdx];
    const val = textarea.value;
    if (tab) {
      tab.content = val;
    }
    const ext = tab?.ext || 'yml';
    highlight.innerHTML = highlightGenericCode(val, ext);
    const lines = val.split('\n').length;
    gutter.innerHTML = Array.from({ length: lines }, (_, i) => i + 1).join('<br>');
    statusPath.textContent = tab ? tab.path : t('editor.no_file');
    statusMetrics.textContent = `${lines} lines · ${new Blob([val]).size} bytes · UTF-8 LF`;
    renderTabs();
  }

  function renderEditor() {
    const tab = tabs[activeIdx];
    textarea.value = tab ? tab.content : '';
    syncHighlighting();
  }

  textarea.addEventListener('input', syncHighlighting);
  stage.addEventListener('scroll', () => {
    gutter.scrollTop = stage.scrollTop;
  });

  textarea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveActiveTab();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const s = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.value = textarea.value.substring(0, s) + '  ' + textarea.value.substring(end);
      textarea.selectionStart = textarea.selectionEnd = s + 2;
      syncHighlighting();
    }
  });

  container.querySelector('#ceSaveBtn').addEventListener('click', saveActiveTab);
  container.querySelector('#ceOpenPathBtn').addEventListener('click', () => {
    const p = window.prompt('Chemin absolu du fichier à éditer :', '/etc/caddy/Caddyfile');
    if (p) openFile(p.trim());
  });

  if (params?.path) {
    await openFile(params.path);
  } else {
    renderEditor();
  }

  return {
    onLaunch(newParams) {
      if (newParams?.path) openFile(newParams.path);
    },
  };
}
