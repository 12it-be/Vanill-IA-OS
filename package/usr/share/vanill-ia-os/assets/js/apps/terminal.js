/**
 * ==============================================================================
 * Vanill-IA OS — Interactive Web Terminal (`terminal.js`)
 * - Stateful working directory (`cd`), Up/Down command history, Ctrl+L clear
 * - Instant switch between Debian Host (`root`) and running Docker Containers
 * - Optional 1-click switch to full PTY `ttyd` iframe when active on port 7681
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

export async function mountApp({ container, api, params }) {
  let target = params?.container || 'host';
  let cwd = '/root';
  let hostname = 'debian';
  let cmdHistory = [];
  let histCursor = -1;
  let lastFailedExchange = null;

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;background:#090B10;color:#E2E8F0;font-family:var(--font-mono);">
      <div class="toolbar-row" style="padding:8px 14px;border-bottom:1px solid rgba(255,255,255,0.09);background:rgba(20,24,33,0.95);">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span style="font-size:0.78rem;color:var(--os-text-secondary);" data-i18n="terminal.target">${escapeHtml(t('terminal.target'))}</span>
          <select class="os-select" id="termTargetSel" style="padding:5px 10px;font-size:0.78rem;max-width:250px;">
            <option value="host" data-i18n="terminal.host_bash">${escapeHtml(t('terminal.host_bash'))}</option>
          </select>
          <span id="termCwdBadge" class="status-pill-sm status-info">/root</span>
        </div>
        <div style="display:flex;gap:6px;">
          <button type="button" class="btn-xs ai-diag hidden" id="termAiFixBtn" data-i18n="terminal.ai_explain">✨ ${escapeHtml(t('terminal.ai_explain'))}</button>
          <button type="button" class="btn-xs hidden" id="termTtydBtn">🖵 PTY ttyd</button>
          <button type="button" class="btn-xs" id="termClearBtn" data-i18n="terminal.clear_btn">${escapeHtml(t('terminal.clear_btn'))}</button>
        </div>
      </div>

      <div id="termScreen" class="selectable" style="flex:1;padding:14px 16px;overflow-y:auto;font-size:0.82rem;line-height:1.55;"></div>

      <form id="termPromptForm" style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid rgba(255,255,255,0.09);background:#0D1017;">
        <span id="termPromptPrefix" style="color:#10B981;font-weight:700;font-size:0.82rem;white-space:nowrap;">root@debian:/root#</span>
        <input type="text" id="termCmdInput" autocomplete="off" spellcheck="false" style="flex:1;background:transparent;border:none;outline:none;color:#F8FAFC;font-family:var(--font-mono);font-size:0.84rem;" data-i18n-placeholder="terminal.input_ph" placeholder="${escapeHtml(t('terminal.input_ph'))}">
      </form>
    </div>
  `;

  const targetSel = container.querySelector('#termTargetSel');
  const cwdBadge = container.querySelector('#termCwdBadge');
  const screen = container.querySelector('#termScreen');
  const form = container.querySelector('#termPromptForm');
  const prefixEl = container.querySelector('#termPromptPrefix');
  const input = container.querySelector('#termCmdInput');
  const aiFixBtn = container.querySelector('#termAiFixBtn');
  const ttydBtn = container.querySelector('#termTtydBtn');

  const appendLine = (html) => {
    const div = document.createElement('div');
    div.innerHTML = html;
    screen.appendChild(div);
    screen.scrollTop = screen.scrollHeight;
  };

  const updatePromptLabel = () => {
    if (target === 'host') {
      prefixEl.style.color = '#10B981';
      prefixEl.textContent = `root@${hostname}:${cwd}#`;
      cwdBadge.textContent = cwd;
    } else {
      prefixEl.style.color = '#38BDF8';
      prefixEl.textContent = `docker:${target}:/#`;
      cwdBadge.textContent = `conteneur:${target}`;
    }
  };

  try {
    const initData = await api.get('/api/terminal.php?action=init');
    cwd = initData.cwd || '/root';
    hostname = initData.hostname || 'debian';

    (initData.containers || []).forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.name;
      opt.textContent = `📦 Conteneur : ${c.name}`;
      targetSel.appendChild(opt);
    });

    if (target !== 'host') {
      targetSel.value = target;
    }

    if (initData.ttyd_open) {
      ttydBtn.classList.remove('hidden');
      ttydBtn.addEventListener('click', () => {
        const ttydUrl = `${window.location.protocol}//${window.location.hostname}:7681`;
        screen.innerHTML = `<iframe src="${escapeHtml(ttydUrl)}" style="width:100%;height:100%;border:none;"></iframe>`;
        form.classList.add('hidden');
      });
    }

    appendLine(`<span style="color:#FF6D5A;font-weight:700;">Vanill-IA OS Interactive Shell</span> <span style="color:#64748B;">— Debian (${escapeHtml(hostname)}) · Type 'clear' or Ctrl+L to clear</span>`);
    if (!initData.agent_online) {
      appendLine(`<span style="color:#F59E0B;">[Info] Daemon vanill-ia-agent is offline on this preview host.</span>`);
    }
  } catch (err) {
    appendLine(`<span style="color:#EF4444;">[Init error] ${escapeHtml(err.message)}</span>`);
  }

  updatePromptLabel();
  setTimeout(() => input.focus(), 40);

  targetSel.addEventListener('change', () => {
    target = targetSel.value;
    updatePromptLabel();
    input.focus();
  });

  container.querySelector('#termClearBtn').addEventListener('click', () => {
    screen.innerHTML = '';
    input.focus();
  });

  aiFixBtn.addEventListener('click', () => {
    if (!lastFailedExchange) return;
    window.__VANILLIA_DESKTOP__?.launchAppById('vanill-ia-chat', {
      context_type: 'security_diag',
      target: `Commande Terminal (${target})`,
      logs: `Cible: ${target}\nRépertoire: ${cwd}\nCommande: ${lastFailedExchange.cmd}\nCode retour: ${lastFailedExchange.code}\n\nSortie:\n${lastFailedExchange.output}`,
    });
  });

  input.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      screen.innerHTML = '';
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (cmdHistory.length > 0 && histCursor < cmdHistory.length - 1) {
        histCursor += 1;
        input.value = cmdHistory[cmdHistory.length - 1 - histCursor];
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histCursor > 0) {
        histCursor -= 1;
        input.value = cmdHistory[cmdHistory.length - 1 - histCursor];
      } else {
        histCursor = -1;
        input.value = '';
      }
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const cmd = input.value.trim();
    if (!cmd) return;

    if (cmd === 'clear') {
      screen.innerHTML = '';
      input.value = '';
      return;
    }

    cmdHistory.push(cmd);
    histCursor = -1;
    input.value = '';
    input.disabled = true;

    appendLine(`<div style="margin-top:6px;"><span style="color:#10B981;font-weight:700;">${escapeHtml(prefixEl.textContent)}</span> <span style="color:#FFFFFF;">${escapeHtml(cmd)}</span></div>`);

    try {
      const res = await api.post('/api/terminal.php?action=exec', {
        target,
        command: cmd,
        cwd,
      });

      if (target === 'host' && res.cwd) {
        cwd = res.cwd;
      }
      updatePromptLabel();

      if (res.stdout) {
        appendLine(`<pre style="margin:2px 0;white-space:pre-wrap;word-break:break-all;color:#CBD5E1;">${escapeHtml(res.stdout)}</pre>`);
      }
      if (res.stderr) {
        appendLine(`<pre style="margin:2px 0;white-space:pre-wrap;word-break:break-all;color:#FCA5A5;">${escapeHtml(res.stderr)}</pre>`);
      }

      if (Number(res.exit_code) !== 0) {
        appendLine(`<span style="color:#EF4444;font-size:0.74rem;">[Code retour : ${res.exit_code}]</span>`);
        lastFailedExchange = {
          cmd,
          code: res.exit_code,
          output: [res.stdout, res.stderr].filter(Boolean).join('\n'),
        };
        aiFixBtn.classList.remove('hidden');
      } else {
        aiFixBtn.classList.add('hidden');
      }
    } catch (err) {
      appendLine(`<span style="color:#EF4444;">[Erreur] ${escapeHtml(err.message)}</span>`);
    } finally {
      input.disabled = false;
      input.focus();
    }
  });

  screen.addEventListener('click', () => {
    if (window.getSelection()?.toString() === '') {
      input.focus();
    }
  });

  const executeInjectedCommand = (rawCmd) => {
    if (!rawCmd || typeof rawCmd !== 'string') return;
    target = 'host';
    targetSel.value = 'host';
    updatePromptLabel();
    input.value = rawCmd.trim();
    form.requestSubmit();
  };

  if (params?.runCommand) {
    setTimeout(() => executeInjectedCommand(params.runCommand), 80);
  }

  return {
    onLaunch(newParams) {
      if (newParams?.runCommand) {
        executeInjectedCommand(newParams.runCommand);
      }
    },
  };
}
