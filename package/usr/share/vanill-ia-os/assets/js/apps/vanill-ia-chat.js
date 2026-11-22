/**
 * ==============================================================================
 * Vanill-IA OS — Native AI Layer & SysAdmin Assistant (`vanill-ia-chat.js`)
 * - Default Engine: Google Gemini 3.8 Flash (1,048,576 ctx / 65,536 max out)
 * - Full BYOK & Local Ollama Support with ZERO arbitrary parameter clamping
 * - Vision Image Upload, Collapsible Reasoning Trace & 1-Click Code Copy
 * - Receives Contextual Diagnostics from Docker, Systemd, Cron & Terminal
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

function renderAiMessageMarkdown(raw) {
  let codeIdx = 0;
  const codeBlocks = [];

  // Extraction propre des blocs ```lang ... ``` avant échappement HTML
  const tokenized = String(raw || '').replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const token = `__CODE_BLOCK_${codeIdx++}__`;
    codeBlocks.push({ lang: lang || 'code', code: code.trimEnd() });
    return token;
  });

  let html = escapeHtml(tokenized);
  html = html.replace(/`([^`\n]+)`/g, '<code style="padding:2px 6px;border-radius:5px;background:rgba(255,255,255,0.1);font-family:var(--font-mono);font-size:0.84em;">$1</code>');
  html = html.replace(/^### (.+)$/gm, '<strong style="display:block;margin:10px 0 4px;font-size:0.95rem;">$1</strong>');
  html = html.replace(/^## (.+)$/gm, '<strong style="display:block;margin:12px 0 5px;font-size:1.03rem;color:var(--os-accent);">$1</strong>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\n/g, '<br>');

  codeBlocks.forEach((blk, idx) => {
    const blockHtml = `
      <div style="margin:10px 0;border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,0.12);background:#080A0F;">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 12px;background:rgba(255,255,255,0.05);font-family:var(--font-mono);font-size:0.72rem;color:var(--os-text-secondary);">
          <span>${escapeHtml(blk.lang)}</span>
          <button type="button" class="btn-xs" data-copy-code="${encodeURIComponent(blk.code)}" style="padding:2px 8px;font-size:0.7rem;">Copier</button>
        </div>
        <pre style="padding:11px 13px;margin:0;overflow-x:auto;font-family:var(--font-mono);font-size:0.79rem;line-height:1.5;color:#E2E8F0;"><code>${escapeHtml(blk.code)}</code></pre>
      </div>
    `;
    html = html.replace(`__CODE_BLOCK_${idx}__`, blockHtml);
  });

  return html;
}

export async function mountApp({ container, api, params }) {
  let configs = [];
  let conversations = [];
  let selectedConfigId = 0;
  let currentConvId = 0;
  let messages = [];
  let autoContext = true;
  let mode = 'chat'; // chat | engines
  let pendingImage = null; // { mime, base64, name }
  let editingEngine = null;

  container.innerHTML = `
    <div class="module-layout">
      <aside class="module-sidebar" style="width:235px;">
        <button type="button" class="os-btn os-btn-primary" id="aiNewChatBtn" data-i18n="ai.new_chat" style="padding:8px 12px;font-size:0.82rem;margin-bottom:6px;">${escapeHtml(t('ai.new_chat'))}</button>
        <button type="button" class="module-nav-btn" id="aiManageEnginesBtn">⚙️ <span data-i18n="ai.manage_engines">${escapeHtml(t('ai.manage_engines'))}</span></button>
        <div style="height:1px;background:var(--os-border);margin:6px 4px;"></div>
        <div style="font-size:0.71rem;font-weight:700;color:var(--os-text-muted);padding:2px 10px;text-transform:uppercase;" data-i18n="ai.history">${escapeHtml(t('ai.history'))}</div>
        <div id="aiConvList" style="display:flex;flex-direction:column;gap:3px;flex:1;overflow-y:auto;"></div>
      </aside>

      <div style="flex:1;display:flex;flex-direction:column;min-width:0;height:100%;" id="aiRightStage"></div>
    </div>
    <input type="file" id="aiVisionInput" accept="image/png,image/jpeg,image/webp,image/gif" class="hidden">
  `;

  const convListEl = container.querySelector('#aiConvList');
  const rightStage = container.querySelector('#aiRightStage');
  const visionInput = container.querySelector('#aiVisionInput');
  const notify = (msg, type = 'info') => window.__VANILLIA_DESKTOP__?.toast(msg, type);

  async function bootstrap() {
    const data = await api.get('/api/ai.php?action=bootstrap');
    configs = data.configs || [];
    conversations = data.conversations || [];
    autoContext = Boolean(data.auto_context);

    if (!selectedConfigId && configs.length > 0) {
      const def = configs.find((c) => c.is_default && c.enabled) || configs[0];
      selectedConfigId = def.id;
    }

    renderSidebarConversations();
    if (mode === 'chat') {
      renderChatStage();
    } else {
      renderEnginesStage();
    }
  }

  function renderSidebarConversations() {
    convListEl.innerHTML = conversations.map((c) => `
      <div style="display:flex;align-items:center;gap:2px;">
        <button type="button" class="module-nav-btn ${Number(c.id) === currentConvId && mode === 'chat' ? 'active' : ''}" data-conv-id="${c.id}" style="flex:1;min-width:0;">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            ${c.context_type !== 'chat' ? '🩺 ' : '💬 '}${escapeHtml(c.title)}
          </span>
        </button>
        <button type="button" class="btn-xs danger" data-del-conv="${c.id}" style="padding:4px 6px;border:none;background:transparent;" title="Supprimer">✕</button>
      </div>
    `).join('') || `<div style="padding:10px;font-size:0.77rem;color:var(--os-text-muted);">Aucune discussion enregistrée.</div>`;

    convListEl.querySelectorAll('[data-conv-id]').forEach((btn) => {
      btn.addEventListener('click', () => openConversation(Number(btn.dataset.convId)));
    });

    convListEl.querySelectorAll('[data-del-conv]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = Number(btn.dataset.delConv);
        await api.post('/api/ai.php?action=conversation_delete', { id });
        if (currentConvId === id) {
          currentConvId = 0;
          messages = [];
        }
        await bootstrap();
      });
    });
  }

  async function openConversation(id) {
    mode = 'chat';
    container.querySelector('#aiManageEnginesBtn').classList.remove('active');
    const res = await api.get(`/api/ai.php?action=conversation_get&id=${id}`);
    currentConvId = id;
    messages = res.messages || [];
    if (res.conversation?.ai_config_id) {
      selectedConfigId = Number(res.conversation.ai_config_id);
    }
    renderSidebarConversations();
    renderChatStage();
  }

  // ==========================================================================
  // VUE 1 : CHAT & ASSISTANT DIAGNOSTIC SYSADMIN
  // ==========================================================================

  function renderChatStage(prefillPrompt = '', diagMeta = null) {
    const enabledConfigs = configs.filter((c) => c.enabled);

    rightStage.innerHTML = `
      <div class="toolbar-row" style="padding:10px 16px;border-bottom:1px solid var(--os-border);">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <strong style="color:var(--os-accent);">✨ Vanill-IA</strong>
          <select class="os-select" id="chatEngineSelect" style="padding:5px 10px;font-size:0.8rem;max-width:300px;">
            ${enabledConfigs.map((c) => `
              <option value="${c.id}" ${c.id === selectedConfigId ? 'selected' : ''}>
                ${escapeHtml(c.name)} — ${escapeHtml(c.model_id)}
              </option>
            `).join('')}
          </select>
        </div>
        <button type="button" class="btn-xs" id="quickConfigBtn">${escapeHtml(t('ai.keys_settings'))}</button>
      </div>

      <div id="chatMessagesScroll" class="selectable" style="flex:1;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:14px;">
        ${messages.length === 0 ? `
          <div class="settings-card" style="max-width:560px;margin:auto;text-align:center;padding:28px;">
            <img src="/assets/img/icons/logo.svg" alt="Vanill-IA" style="width:52px;height:52px;border-radius:14px;margin-bottom:12px;">
            <h3>${escapeHtml(t('ai.welcome_title'))}</h3>
            <p class="desc">${escapeHtml(t('ai.welcome_desc'))}</p>
            <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center;">
              <button type="button" class="btn-xs" data-quick-q="Audit the security of my Debian server and provide a UFW + SSH + Fail2ban checklist.">🛡️ Debian Security Checklist</button>
              <button type="button" class="btn-xs" data-quick-q="Generate a hardened docker-compose.yml for PostgreSQL 17 with healthcheck.">🐳 Compose PostgreSQL 17</button>
            </div>
          </div>
        ` : messages.map((m) => renderSingleBubble(m)).join('')}
      </div>

      <div id="visionAttachmentBar" class="${pendingImage ? '' : 'hidden'}" style="padding:6px 18px;border-top:1px solid var(--os-border);font-size:0.76rem;display:flex;justify-content:space-between;align-items:center;">
        <span>🖼️ <strong id="visionFileName">${escapeHtml(pendingImage?.name || '')}</strong></span>
        <button type="button" class="btn-xs danger" id="clearVisionBtn">${escapeHtml(t('common.delete'))}</button>
      </div>

      <form id="chatSendForm" style="padding:12px 16px;border-top:1px solid var(--os-border);display:flex;gap:8px;align-items:flex-end;">
        <button type="button" class="btn-xs" id="attachImgBtn" style="height:40px;padding:0 11px;" title="Vision Image">🖼️</button>
        <textarea class="os-input" id="chatInputArea" rows="2" placeholder="${escapeHtml(t('ai.input_ph'))}" style="resize:none;flex:1;">${escapeHtml(prefillPrompt)}</textarea>
        <button type="submit" class="os-btn os-btn-primary" id="chatSendBtn" style="width:auto;height:40px;padding:0 18px;">${escapeHtml(t('ai.send'))}</button>
      </form>
    `;

    const scrollBox = rightStage.querySelector('#chatMessagesScroll');
    scrollBox.scrollTop = scrollBox.scrollHeight;
    bindCopyCodeButtons(scrollBox);

    rightStage.querySelector('#chatEngineSelect')?.addEventListener('change', (e) => {
      selectedConfigId = Number(e.target.value);
    });
    rightStage.querySelector('#quickConfigBtn').addEventListener('click', () => {
      mode = 'engines';
      container.querySelector('#aiManageEnginesBtn').classList.add('active');
      renderEnginesStage();
    });

    rightStage.querySelectorAll('[data-quick-q]').forEach((btn) => {
      btn.addEventListener('click', () => {
        rightStage.querySelector('#chatInputArea').value = btn.dataset.quickQ;
        rightStage.querySelector('#chatInputArea').focus();
      });
    });

    rightStage.querySelector('#attachImgBtn').addEventListener('click', () => visionInput.click());
    rightStage.querySelector('#clearVisionBtn')?.addEventListener('click', () => {
      pendingImage = null;
      rightStage.querySelector('#visionAttachmentBar').classList.add('hidden');
    });

    const inputArea = rightStage.querySelector('#chatInputArea');
    const sendForm = rightStage.querySelector('#chatSendForm');

    inputArea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendForm.requestSubmit();
      }
    });

    sendForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = inputArea.value.trim();
      if (!text) return;

      const sendBtn = rightStage.querySelector('#chatSendBtn');
      sendBtn.disabled = true;
      sendBtn.textContent = '⏳...';
      inputArea.value = '';

      messages.push({ role: 'user', content: text });
      renderChatStage();

      try {
        const payload = {
          config_id: selectedConfigId,
          conversation_id: currentConvId,
          message: text,
          context_type: diagMeta?.context_type || 'chat',
          context_target: diagMeta?.target || null,
        };
        if (pendingImage) {
          payload.image_base64 = pendingImage.base64;
          payload.image_mime = pendingImage.mime;
          pendingImage = null;
        }

        const res = await api.post('/api/ai.php?action=chat', payload);
        currentConvId = res.conversation_id;
        messages.push(res.assistant);
        diagMeta = null;
        await bootstrap();
      } catch (err) {
        notify(err.message, 'error');
        renderChatStage(text, diagMeta);
      }
    });

    if (diagMeta && prefillPrompt) {
      sendForm.requestSubmit();
    }
  }

  function renderSingleBubble(m) {
    const isUser = m.role === 'user';
    const reasoningHtml = m.reasoning_text
      ? `<details style="margin-bottom:8px;padding:8px 10px;border-radius:9px;background:rgba(255,255,255,0.04);font-size:0.78rem;color:var(--os-text-secondary);">
           <summary style="cursor:pointer;font-weight:600;">🧠 Raisonnement du modèle</summary>
           <div style="margin-top:6px;white-space:pre-wrap;">${escapeHtml(m.reasoning_text)}</div>
         </details>`
      : '';

    const metaFooter = !isUser && m.duration_ms
      ? `<div style="margin-top:6px;font-size:0.7rem;color:var(--os-text-muted);font-family:var(--font-mono);">
           ${m.duration_ms} ms${m.tokens_output ? ` · ${m.tokens_input || '?'}→${m.tokens_output} tokens` : ''}
         </div>`
      : '';

    return `
      <div style="align-self:${isUser ? 'flex-end' : 'flex-start'};max-width:86%;padding:12px 15px;border-radius:16px;background:${isUser ? 'var(--os-accent-soft)' : 'rgba(255,255,255,0.045)'};border:1px solid ${isUser ? 'rgba(255,109,90,0.35)' : 'var(--os-border)'};">
        ${reasoningHtml}
        <div style="font-size:0.86rem;line-height:1.58;">${isUser ? escapeHtml(m.content).replace(/\n/g, '<br>') : renderAiMessageMarkdown(m.content)}</div>
        ${metaFooter}
      </div>
    `;
  }

  function bindCopyCodeButtons(root) {
    root.querySelectorAll('[data-copy-code]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const raw = decodeURIComponent(btn.dataset.copyCode);
        await navigator.clipboard.writeText(raw);
        btn.textContent = '✓ Copié';
        setTimeout(() => { btn.textContent = 'Copier'; }, 1500);
      });
    });
  }

  visionInput.addEventListener('change', () => {
    const file = visionInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const base64 = dataUrl.split(',')[1] || '';
      pendingImage = { mime: file.type, base64, name: file.name };
      renderChatStage(rightStage.querySelector('#chatInputArea')?.value || '');
    };
    reader.readAsDataURL(file);
    visionInput.value = '';
  });

  // ==========================================================================
  // VUE 2 : ADMINISTRATION COMPLÈTE DES MOTEURS IA (ZÉRO BRIDAGE)
  // ==========================================================================

  function renderEnginesStage() {
    const cfg = editingEngine || configs[0] || {
      id: 0,
      name: 'Nouveau Moteur IA',
      provider_type: 'gemini',
      base_url: 'https://generativelanguage.googleapis.com/v1beta',
      model_id: 'gemini-3.8-flash',
      context_window: 1048576,
      max_output_tokens: 65536,
      temperature: 0.3,
      top_p: 0.95,
      top_k: '',
      reasoning_effort: '',
      supports_vision: true,
      supports_reasoning: true,
      supports_tools: true,
      timeout_seconds: 120,
      system_prompt: 'Tu es Vanill-IA, expert SysAdmin Debian & Docker intégré à Vanill-IA OS.',
      extra_headers_json: '{}',
      extra_body_json: '{}',
      is_default: false,
      enabled: true,
    };

    rightStage.innerHTML = `
      <div class="module-content">
        <div class="toolbar-row">
          <div>
            <h3 style="margin:0;">Administration Complète des Moteurs IA (BYOK & Ollama)</h3>
            <p class="desc" style="margin:2px 0 0;">Contrôle total sans bridage sur les fenêtres de contexte, tokens max, températures, prompts système et JSON additionnels.</p>
          </div>
          <div style="display:flex;gap:8px;">
            <button type="button" class="btn-xs" id="backToChatBtn">← Retour au Chat</button>
            <button type="button" class="btn-xs primary" id="newEngineBtn">+ Ajouter un Moteur</button>
          </div>
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          ${configs.map((c) => `
            <button type="button" class="btn-xs ${c.id === cfg.id ? 'primary' : ''}" data-pick-eng="${c.id}">
              ${c.is_default ? '★ ' : ''}${escapeHtml(c.name)} (${escapeHtml(c.model_id)})
            </button>
          `).join('')}
        </div>

        <form id="engineConfigForm" class="settings-card" style="display:flex;flex-direction:column;gap:12px;">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;">
            <div>
              <label class="form-label">Nom affiché</label>
              <input type="text" class="os-input" name="name" value="${escapeHtml(cfg.name)}" required>
            </div>
            <div>
              <label class="form-label">Protocole / Fournisseur</label>
              <select class="os-select" name="provider_type" id="engProviderSel">
                <option value="gemini" ${cfg.provider_type === 'gemini' ? 'selected' : ''}>Google Gemini (generateContent)</option>
                <option value="ollama" ${cfg.provider_type === 'ollama' ? 'selected' : ''}>Ollama Local (/api/chat)</option>
                <option value="openrouter" ${cfg.provider_type === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
                <option value="openai" ${cfg.provider_type === 'openai' ? 'selected' : ''}>OpenAI</option>
                <option value="anthropic" ${cfg.provider_type === 'anthropic' ? 'selected' : ''}>Anthropic (/v1/messages)</option>
                <option value="custom_openai" ${cfg.provider_type === 'custom_openai' ? 'selected' : ''}>Compatible OpenAI Custom (vLLM / LM Studio)</option>
              </select>
            </div>
            <div>
              <label class="form-label">URL de base API</label>
              <input type="text" class="os-input" name="base_url" id="engBaseUrl" value="${escapeHtml(cfg.base_url)}" required style="font-family:var(--font-mono);font-size:0.8rem;">
            </div>
          </div>

          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;">
            <div>
              <label class="form-label">
                <span>ID du Modèle (saisie libre)</span>
                <button type="button" id="discoverModelsBtn" style="color:var(--os-accent);font-size:0.74rem;">🔍 Lister depuis l'API</button>
              </label>
              <input type="text" class="os-input" name="model_id" id="engModelId" value="${escapeHtml(cfg.model_id)}" required style="font-family:var(--font-mono);">
            </div>
            <div>
              <label class="form-label">Clé API (chiffrée Sodium · ${cfg.has_api_key ? `Actuelle : ${escapeHtml(cfg.api_key_masked)}` : 'Aucune clé'})</label>
              <input type="password" class="os-input" name="api_key" placeholder="${cfg.has_api_key ? 'Laisser vide pour conserver la clé actuelle' : 'AIza... / sk-...'}" autocomplete="new-password">
            </div>
          </div>

          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:10px;">
            <div>
              <label class="form-label">Contexte (tokens)</label>
              <input type="number" class="os-input" name="context_window" value="${cfg.context_window}" min="1" required style="font-family:var(--font-mono);">
            </div>
            <div>
              <label class="form-label">Sortie Max (tokens)</label>
              <input type="number" class="os-input" name="max_output_tokens" value="${cfg.max_output_tokens}" min="1" required style="font-family:var(--font-mono);">
            </div>
            <div>
              <label class="form-label">Température</label>
              <input type="number" step="0.01" class="os-input" name="temperature" value="${cfg.temperature ?? ''}" placeholder="0.3">
            </div>
            <div>
              <label class="form-label">Top P</label>
              <input type="number" step="0.01" class="os-input" name="top_p" value="${cfg.top_p ?? ''}" placeholder="0.95">
            </div>
            <div>
              <label class="form-label">Top K</label>
              <input type="number" class="os-input" name="top_k" value="${cfg.top_k ?? ''}" placeholder="Auto">
            </div>
            <div>
              <label class="form-label">Timeout (s)</label>
              <input type="number" class="os-input" name="timeout_seconds" value="${cfg.timeout_seconds || 120}" min="5">
            </div>
          </div>

          <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:0.82rem;">
            <label><input type="checkbox" name="supports_vision" ${cfg.supports_vision ? 'checked' : ''}> Vision</label>
            <label><input type="checkbox" name="supports_reasoning" ${cfg.supports_reasoning ? 'checked' : ''}> Raisonnement</label>
            <label><input type="checkbox" name="supports_tools" ${cfg.supports_tools ? 'checked' : ''}> Outils</label>
            <label><input type="checkbox" name="is_default" ${cfg.is_default ? 'checked' : ''}> Moteur par défaut</label>
            <label><input type="checkbox" name="enabled" ${cfg.enabled ? 'checked' : ''}> Actif</label>
            <label><input type="checkbox" name="auto_context" ${autoContext ? 'checked' : ''}> Injecter télémétrie Debian live</label>
          </div>

          <div>
            <label class="form-label">System Prompt</label>
            <textarea class="os-input" name="system_prompt" rows="3" style="font-size:0.82rem;">${escapeHtml(cfg.system_prompt)}</textarea>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div>
              <label class="form-label">Headers HTTP additionnels (JSON)</label>
              <textarea class="os-input" name="extra_headers_json" rows="2" style="font-family:var(--font-mono);font-size:0.77rem;">${escapeHtml(cfg.extra_headers_json || '{}')}</textarea>
            </div>
            <div>
              <label class="form-label">Payload Body additionnel (JSON)</label>
              <textarea class="os-input" name="extra_body_json" rows="2" style="font-family:var(--font-mono);font-size:0.77rem;">${escapeHtml(cfg.extra_body_json || '{}')}</textarea>
            </div>
          </div>

          <div style="display:flex;justify-content:space-between;gap:10px;">
            <button type="submit" class="os-btn os-btn-primary" style="width:auto;">💾 Enregistrer ce Moteur IA</button>
            ${cfg.id ? `<button type="button" class="btn-xs danger" id="delEngineBtn">Supprimer ce moteur</button>` : ''}
          </div>
        </form>
      </div>
    `;

    rightStage.querySelector('#backToChatBtn').addEventListener('click', () => {
      mode = 'chat';
      container.querySelector('#aiManageEnginesBtn').classList.remove('active');
      renderChatStage();
    });

    rightStage.querySelector('#newEngineBtn').addEventListener('click', () => {
      editingEngine = {
        id: 0,
        name: 'Custom LLM',
        provider_type: 'custom_openai',
        base_url: 'http://127.0.0.1:11434/v1',
        model_id: 'qwen2.5-coder:14b',
        context_window: 131072,
        max_output_tokens: 32768,
        temperature: 0.2,
        top_p: 0.95,
        supports_vision: false,
        supports_reasoning: true,
        supports_tools: true,
        timeout_seconds: 120,
        system_prompt: 'Tu es Vanill-IA, expert SysAdmin Debian.',
        extra_headers_json: '{}',
        extra_body_json: '{}',
        is_default: false,
        enabled: true,
      };
      renderEnginesStage();
    });

    rightStage.querySelectorAll('[data-pick-eng]').forEach((btn) => {
      btn.addEventListener('click', () => {
        editingEngine = configs.find((x) => x.id === Number(btn.dataset.pickEng)) || null;
        renderEnginesStage();
      });
    });

    rightStage.querySelector('#discoverModelsBtn').addEventListener('click', async () => {
      try {
        const res = await api.post('/api/ai.php?action=discover_models', {
          provider_type: rightStage.querySelector('#engProviderSel').value,
          base_url: rightStage.querySelector('#engBaseUrl').value,
        });
        const models = res.models || [];
        if (models.length === 0) {
          notify('Aucun modèle retourné par ce serveur.');
          return;
        }
        const picked = window.prompt(`Modèles disponibles (${models.length}) :\n${models.slice(0, 20).join(', ')}`, models[0]);
        if (picked) {
          rightStage.querySelector('#engModelId').value = picked.trim();
        }
      } catch (err) {
        notify(err.message, 'error');
      }
    });

    rightStage.querySelector('#delEngineBtn')?.addEventListener('click', async () => {
      if (!window.confirm(`Supprimer le moteur "${cfg.name}" ?`)) return;
      await api.post('/api/ai.php?action=config_delete', { id: cfg.id });
      editingEngine = null;
      await bootstrap();
    });

    rightStage.querySelector('#engineConfigForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      try {
        const res = await api.post('/api/ai.php?action=config_save', {
          id: cfg.id,
          name: fd.get('name'),
          provider_type: fd.get('provider_type'),
          base_url: fd.get('base_url'),
          api_key: fd.get('api_key'),
          model_id: fd.get('model_id'),
          context_window: Number(fd.get('context_window')),
          max_output_tokens: Number(fd.get('max_output_tokens')),
          temperature: fd.get('temperature'),
          top_p: fd.get('top_p'),
          top_k: fd.get('top_k'),
          timeout_seconds: Number(fd.get('timeout_seconds')),
          supports_vision: fd.get('supports_vision') === 'on',
          supports_reasoning: fd.get('supports_reasoning') === 'on',
          supports_tools: fd.get('supports_tools') === 'on',
          is_default: fd.get('is_default') === 'on',
          enabled: fd.get('enabled') === 'on',
          auto_context: fd.get('auto_context') === 'on',
          system_prompt: fd.get('system_prompt'),
          extra_headers_json: fd.get('extra_headers_json'),
          extra_body_json: fd.get('extra_body_json'),
        });
        configs = res.configs || [];
        editingEngine = configs.find((x) => x.name === fd.get('name')) || configs[0] || null;
        notify('Moteur IA enregistré avec succès.');
        renderEnginesStage();
      } catch (err) {
        notify(err.message, 'error');
      }
    });
  }

  // Boutons barre latérale
  container.querySelector('#aiNewChatBtn').addEventListener('click', () => {
    mode = 'chat';
    currentConvId = 0;
    messages = [];
    container.querySelector('#aiManageEnginesBtn').classList.remove('active');
    renderSidebarConversations();
    renderChatStage();
  });

  container.querySelector('#aiManageEnginesBtn').addEventListener('click', (e) => {
    mode = 'engines';
    e.currentTarget.classList.add('active');
    editingEngine = configs[0] || null;
    renderEnginesStage();
  });

  // Prise en charge directe d'un diagnostic envoyé par Docker / Systemd / Cron / Terminal
  const handleDiagnosticPayload = (diag) => {
    if (!diag || !diag.logs) return;
    mode = 'chat';
    currentConvId = 0;
    messages = [];
    const prompt = `Analyse ce diagnostic issu de Vanill-IA OS (${diag.context_type || 'sysadmin'}) pour la cible "${diag.target || 'système'}", identifie la cause racine exacte et donne les commandes correctives précises :\n\n\`\`\`text\n${String(diag.logs).slice(-12000)}\n\`\`\``;
    renderChatStage(prompt, diag);
  };

  await bootstrap();
  if (params?.logs) {
    handleDiagnosticPayload(params);
  }

  const onLangChanged = () => {
    renderSidebarConversations();
    if (mode === 'chat') renderChatStage();
  };
  window.addEventListener('vanillia:lang-changed', onLangChanged);

  return {
    cleanup() {
      window.removeEventListener('vanillia:lang-changed', onLangChanged);
    },
    onLaunch(newParams) {
      if (newParams?.logs) {
        handleDiagnosticPayload(newParams);
      }
    },
  };
}
