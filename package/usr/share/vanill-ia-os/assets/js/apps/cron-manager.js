/**
 * ==============================================================================
 * Vanill-IA OS — Visual Cron Scheduler (/etc/cron.d/vanill-ia)
 * - French human-readable cron translator + Next 3 executions preview
 * - Wrapper telemetry (`vanill-ia-cron-run`) with exit code, duration & output
 * - 1-Click "Run Now" + Contextual AI Diagnostic on failed tasks
 * ==============================================================================
 */

import { t, getLanguage, getLocaleTag } from '../i18n.js';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const DAYS_FR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const DAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * Translates a Cron expression into natural English or French according to active user language.
 */
function translateCronHuman(expr) {
  const isFr = getLanguage() === 'fr';
  const e = String(expr || '').trim();
  const macros = isFr ? {
    '@reboot': 'À chaque démarrage du serveur Debian',
    '@hourly': 'Toutes les heures (minute 0)',
    '@daily': 'Tous les jours à minuit (00:00)',
    '@midnight': 'Tous les jours à minuit (00:00)',
    '@weekly': 'Tous les dimanches à minuit (00:00)',
    '@monthly': 'Le 1er de chaque mois à minuit',
    '@yearly': 'Le 1er janvier à minuit',
    '@annually': 'Le 1er janvier à minuit',
  } : {
    '@reboot': 'At every Debian server boot',
    '@hourly': 'Every hour (at minute 0)',
    '@daily': 'Every day at midnight (00:00)',
    '@midnight': 'Every day at midnight (00:00)',
    '@weekly': 'Every Sunday at midnight (00:00)',
    '@monthly': 'On the 1st of every month at midnight',
    '@yearly': 'On January 1st at midnight',
    '@annually': 'On January 1st at midnight',
  };
  if (macros[e]) return macros[e];

  const parts = e.split(/\s+/);
  if (parts.length !== 5) return isFr ? 'Expression cron invalide (5 champs attendus)' : 'Invalid cron expression (5 fields expected)';

  const [min, hour, dom, mon, dow] = parts;
  if (e === '* * * * *') return isFr ? 'Toutes les minutes' : 'Every minute';
  if (/^\*\/(\d+)$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return isFr ? `Toutes les ${min.slice(2)} minutes` : `Every ${min.slice(2)} minutes`;
  }
  if (/^\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return isFr ? `Toutes les heures à :${min.padStart(2, '0')}` : `Every hour at :${min.padStart(2, '0')}`;
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '*') {
    return isFr
      ? `Tous les jours à ${hour.padStart(2, '0')}h${min.padStart(2, '0')}`
      : `Every day at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && /^\d$/.test(dow)) {
    return isFr
      ? `Chaque ${DAYS_FR[Number(dow)] || dow} à ${hour.padStart(2, '0')}h${min.padStart(2, '0')}`
      : `Every ${DAYS_EN[Number(dow)] || dow} at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  }

  return `Cron: min(${min}) hour(${hour}) day(${dom}) month(${mon}) dow(${dow})`;
}

function matchCronField(field, value, maxVal) {
  if (field === '*') return true;
  return field.split(',').some((segment) => {
    let step = 1;
    let rangePart = segment;
    if (segment.includes('/')) {
      const [r, s] = segment.split('/');
      rangePart = r;
      step = parseInt(s, 10) || 1;
    }
    if (rangePart === '*') {
      return value % step === 0;
    }
    if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map((n) => parseInt(n, 10));
      return value >= a && value <= b && (value - a) % step === 0;
    }
    const exact = parseInt(rangePart, 10);
    return exact === value || (maxVal === 7 && exact === 7 && value === 0);
  });
}

/**
 * Calcule les 3 prochaines dates d'exécution d'une expression Cron.
 */
function computeNextRuns(expr, count = 3) {
  let normalized = String(expr || '').trim();
  const macroMap = {
    '@hourly': '0 * * * *',
    '@daily': '0 0 * * *',
    '@midnight': '0 0 * * *',
    '@weekly': '0 0 * * 0',
    '@monthly': '0 0 1 * *',
    '@yearly': '0 0 1 1 *',
    '@annually': '0 0 1 1 *',
  };
  if (normalized === '@reboot') return ['À chaque redémarrage matériel/système'];
  if (macroMap[normalized]) normalized = macroMap[normalized];

  const parts = normalized.split(/\s+/);
  if (parts.length !== 5) return [];

  const [fMin, fHour, fDom, fMon, fDow] = parts;
  const results = [];
  const cursor = new Date();
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  // Recherche bornée sur 525 600 itérations max (1 an minute par minute, mais optimisée par saut d'heure/jour)
  let guard = 0;
  while (results.length < count && guard < 120000) {
    guard += 1;
    const mon = cursor.getMonth() + 1;
    if (!matchCronField(fMon, mon, 12)) {
      cursor.setMonth(cursor.getMonth() + 1, 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }

    const dom = cursor.getDate();
    const dow = cursor.getDay();
    if (!matchCronField(fDom, dom, 31) || !matchCronField(fDow, dow, 7)) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }

    const hr = cursor.getHours();
    if (!matchCronField(fHour, hr, 23)) {
      cursor.setHours(hr + 1, 0, 0, 0);
      continue;
    }

    const mn = cursor.getMinutes();
    if (matchCronField(fMin, mn, 59)) {
      results.push(
        cursor.toLocaleString(getLocaleTag(), {
          weekday: 'short',
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      );
    }
    cursor.setMinutes(mn + 1);
  }

  return results;
}

export async function mountApp({ container, api, params }) {
  let jobs = [];
  let systemUsers = [{ username: 'root' }, { username: 'www-data' }];
  let editingJob = null;

  container.innerHTML = `
    <div class="module-content" id="cronMainPane" style="height:100%;"></div>
    <div id="cronModalSlot"></div>
  `;

  const pane = container.querySelector('#cronMainPane');
  const modalSlot = container.querySelector('#cronModalSlot');
  const notify = (msg, type = 'info') => window.__VANILLIA_DESKTOP__?.toast(msg, type);

  async function loadJobs() {
    try {
      const res = await api.get('/api/cron.php?action=list');
      jobs = res.jobs || [];
      systemUsers = res.system_users || systemUsers;
      renderMain();

      if (params?.job_id) {
        const target = jobs.find((j) => Number(j.id) === Number(params.job_id));
        if (target) openHistoryModal(target);
        params.job_id = null;
      }
    } catch (err) {
      pane.innerHTML = `<div class="os-alert os-alert-error">${escapeHtml(err.message)}</div>`;
    }
  }

  function renderMain() {
    pane.innerHTML = `
      <div class="settings-card" style="padding:15px 18px;">
        <div class="toolbar-row">
          <div>
            <h3 style="margin:0;">${escapeHtml(t('cron.header_title'))}</h3>
            <p class="desc" style="margin:2px 0 0;">${escapeHtml(t('cron.header_desc'))}</p>
          </div>
          <button type="button" class="btn-xs primary" id="newCronBtn">${escapeHtml(t('cron.new_task'))}</button>
        </div>
      </div>

      ${jobs.length === 0 ? `
        <div class="settings-card" style="text-align:center;padding:36px;">
          <h3>${escapeHtml(t('cron.empty_title'))}</h3>
          <button type="button" class="os-btn os-btn-primary" id="emptyNewCronBtn" style="width:auto;margin-top:10px;">${escapeHtml(t('cron.new_task'))}</button>
        </div>
      ` : `
        <div class="cards-grid">
          ${jobs.map((j) => {
            const enabled = Number(j.enabled) === 1;
            const hasRun = j.last_exit_code !== null && j.last_exit_code !== undefined;
            const failed = hasRun && Number(j.last_exit_code) !== 0;

            return `
              <article class="entity-card">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
                  <div>
                    <strong style="font-size:0.95rem;">${escapeHtml(j.title)}</strong>
                    <div style="font-size:0.75rem;color:var(--os-accent);font-weight:500;">${escapeHtml(translateCronHuman(j.schedule))}</div>
                  </div>
                  <label style="display:flex;align-items:center;gap:5px;font-size:0.75rem;cursor:pointer;">
                    <input type="checkbox" data-toggle-cron="${j.id}" ${enabled ? 'checked' : ''}>
                    ${escapeHtml(enabled ? t('common.active') : t('common.paused'))}
                  </label>
                </div>

                <div style="padding:8px 10px;border-radius:10px;background:rgba(0,0,0,0.18);font-family:var(--font-mono);font-size:0.74rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                  <span style="color:var(--os-info);">${escapeHtml(j.run_user)}</span> $ ${escapeHtml(j.command)}
                </div>

                <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.75rem;color:var(--os-text-secondary);">
                  <span style="font-family:var(--font-mono);">${escapeHtml(j.schedule)}</span>
                  ${hasRun ? `
                    <span class="status-pill-sm ${failed ? 'status-error' : 'status-running'}">
                      ${failed ? `Exit (${j.last_exit_code})` : `OK (${j.last_duration_ms} ms)`}
                    </span>
                  ` : `<span class="status-pill-sm status-stopped">Idle</span>`}
                </div>

                <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:auto;padding-top:6px;border-top:1px solid var(--os-border);">
                  <button type="button" class="btn-xs primary" data-run-cron="${j.id}">▶ ${escapeHtml(t('cron.run_now'))}</button>
                  <button type="button" class="btn-xs" data-hist-cron="${j.id}">📜 ${escapeHtml(t('cron.history'))}</button>
                  <button type="button" class="btn-xs" data-edit-cron="${j.id}">✎ ${escapeHtml(t('common.edit'))}</button>
                  ${failed ? `<button type="button" class="btn-xs ai-diag" data-ai-cron="${j.id}">✨ ${escapeHtml(t('common.ai_short'))}</button>` : ''}
                  <button type="button" class="btn-xs danger" data-del-cron="${j.id}" style="margin-left:auto;">✕</button>
                </div>
              </article>
            `;
          }).join('')}
        </div>
      `}
    `;

    pane.querySelector('#newCronBtn')?.addEventListener('click', () => openEditorModal(null));
    pane.querySelector('#emptyNewCronBtn')?.addEventListener('click', () => openEditorModal(null));

    pane.querySelectorAll('[data-toggle-cron]').forEach((chk) => {
      chk.addEventListener('change', async () => {
        try {
          await api.post('/api/cron.php?action=toggle', {
            id: Number(chk.dataset.toggleCron),
            enabled: chk.checked,
          });
          notify('Planification synchronisée dans /etc/cron.d/vanill-ia.');
          await loadJobs();
        } catch (err) {
          notify(err.message, 'error');
        }
      });
    });

    pane.querySelectorAll('[data-run-cron]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.runCron);
        btn.disabled = true;
        btn.textContent = '⏳ En cours...';
        try {
          const res = await api.post('/api/cron.php?action=run_now', { id });
          notify(`Exécution terminée (code retour : ${res.exit_code}).`, res.exit_code === 0 ? 'info' : 'error');
          await loadJobs();
        } catch (err) {
          notify(err.message, 'error');
          btn.disabled = false;
          btn.textContent = '▶ Exécuter';
        }
      });
    });

    pane.querySelectorAll('[data-edit-cron]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const job = jobs.find((x) => Number(x.id) === Number(btn.dataset.editCron));
        if (job) openEditorModal(job);
      });
    });

    pane.querySelectorAll('[data-hist-cron]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const job = jobs.find((x) => Number(x.id) === Number(btn.dataset.histCron));
        if (job) openHistoryModal(job);
      });
    });

    pane.querySelectorAll('[data-ai-cron]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const job = jobs.find((x) => Number(x.id) === Number(btn.dataset.aiCron));
        if (!job) return;
        window.__VANILLIA_DESKTOP__?.launchAppById('vanill-ia-chat', {
          context_type: 'cron_diag',
          target: `${job.title} (${job.command})`,
          logs: `Commande: ${job.command}\nUtilisateur: ${job.run_user}\nCode retour: ${job.last_exit_code}\n\nSortie:\n${job.last_output || '(vide)'}`,
        });
      });
    });

    pane.querySelectorAll('[data-del-cron]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!window.confirm('Supprimer cette tâche planifiée ?')) return;
        try {
          await api.post('/api/cron.php?action=delete', { id: Number(btn.dataset.delCron) });
          notify('Tâche supprimée.');
          await loadJobs();
        } catch (err) {
          notify(err.message, 'error');
        }
      });
    });
  }

  function openEditorModal(job) {
    editingJob = job || {
      id: 0,
      title: '',
      description: '',
      schedule: '0 3 * * *',
      run_user: 'root',
      working_dir: '/root',
      command: '',
      enabled: 1,
      notify_on_fail: 1,
    };

    modalSlot.innerHTML = `
      <div class="inwin-modal-backdrop">
        <div class="inwin-modal">
          <div class="inwin-modal-header">
            <span>${editingJob.id ? 'Modifier la tâche Cron' : 'Nouvelle tâche planifiée'}</span>
            <button type="button" class="btn-xs" id="closeCronEditBtn">Fermer</button>
          </div>
          <div class="inwin-modal-body">
            <form id="cronEditForm">
              <div style="display:grid;grid-template-columns:1fr 170px;gap:10px;">
                <div class="form-group">
                  <label class="form-label">Titre de la tâche</label>
                  <input type="text" class="os-input" name="title" value="${escapeHtml(editingJob.title)}" placeholder="Ex: Sauvegarde quotidienne PostgreSQL" required>
                </div>
                <div class="form-group">
                  <label class="form-label">Utilisateur Linux</label>
                  <select class="os-select" name="run_user">
                    ${systemUsers.map((u) => `<option value="${escapeHtml(u.username)}" ${editingJob.run_user === u.username ? 'selected' : ''}>${escapeHtml(u.username)}</option>`).join('')}
                  </select>
                </div>
              </div>

              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                <div class="form-group">
                  <label class="form-label">Sélecteur rapide</label>
                  <select class="os-select" id="cronPresetSel">
                    <option value="">— Personnalisé —</option>
                    <option value="*/5 * * * *">Toutes les 5 minutes</option>
                    <option value="*/15 * * * *">Toutes les 15 minutes</option>
                    <option value="0 * * * *">Toutes les heures</option>
                    <option value="0 3 * * *">Tous les jours à 03:00</option>
                    <option value="0 4 * * 1">Chaque lundi à 04:00</option>
                    <option value="@reboot">Au démarrage (@reboot)</option>
                  </select>
                </div>
                <div class="form-group">
                  <label class="form-label">Expression Cron</label>
                  <input type="text" class="os-input" name="schedule" id="cronExprInput" value="${escapeHtml(editingJob.schedule)}" required style="font-family:var(--font-mono);">
                </div>
              </div>

              <div class="os-alert os-alert-info" id="cronLivePreview" style="font-size:0.8rem;"></div>

              <div class="form-group">
                <label class="form-label">Répertoire de travail</label>
                <input type="text" class="os-input" name="working_dir" value="${escapeHtml(editingJob.working_dir || '/root')}" style="font-family:var(--font-mono);">
              </div>

              <div class="form-group">
                <label class="form-label">Commande Bash à exécuter</label>
                <textarea class="os-input" name="command" rows="3" required style="font-family:var(--font-mono);font-size:0.82rem;" placeholder="docker system prune -af --volumes=false">${escapeHtml(editingJob.command)}</textarea>
              </div>

              <div style="display:flex;gap:18px;margin-bottom:14px;font-size:0.83rem;">
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                  <input type="checkbox" name="enabled" ${Number(editingJob.enabled) === 1 ? 'checked' : ''}> Activer la tâche
                </label>
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                  <input type="checkbox" name="notify_on_fail" ${Number(editingJob.notify_on_fail) === 1 ? 'checked' : ''}> Alerter dans le centre de notifications si échec
                </label>
              </div>

              <button type="submit" class="os-btn os-btn-primary">Enregistrer & Synchroniser /etc/cron.d/vanill-ia</button>
            </form>
          </div>
        </div>
      </div>
    `;

    const presetSel = modalSlot.querySelector('#cronPresetSel');
    const exprInp = modalSlot.querySelector('#cronExprInput');
    const previewBox = modalSlot.querySelector('#cronLivePreview');

    const updatePreview = () => {
      const val = exprInp.value.trim();
      const fr = translateCronHuman(val);
      const next3 = computeNextRuns(val, 3);
      previewBox.innerHTML = `
        <div><strong>Schedule:</strong> ${escapeHtml(fr)}</div>
        ${next3.length > 0 ? `<div style="margin-top:4px;font-family:var(--font-mono);font-size:0.74rem;">Next: ${next3.map(escapeHtml).join('  ·  ')}</div>` : ''}
      `;
    };

    presetSel.addEventListener('change', () => {
      if (presetSel.value) {
        exprInp.value = presetSel.value;
        updatePreview();
      }
    });
    exprInp.addEventListener('input', updatePreview);
    updatePreview();

    modalSlot.querySelector('#closeCronEditBtn').addEventListener('click', () => { modalSlot.innerHTML = ''; });

    modalSlot.querySelector('#cronEditForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      try {
        await api.post('/api/cron.php?action=save', {
          id: editingJob.id,
          title: fd.get('title'),
          schedule: fd.get('schedule'),
          run_user: fd.get('run_user'),
          working_dir: fd.get('working_dir'),
          command: fd.get('command'),
          enabled: fd.get('enabled') === 'on',
          notify_on_fail: fd.get('notify_on_fail') === 'on',
        });
        modalSlot.innerHTML = '';
        notify('Tâche planifiée enregistrée.');
        await loadJobs();
      } catch (err) {
        notify(err.message, 'error');
      }
    });
  }

  async function openHistoryModal(job) {
    try {
      const res = await api.get(`/api/cron.php?action=logs&job_id=${job.id}`);
      const logs = res.logs || [];

      modalSlot.innerHTML = `
        <div class="inwin-modal-backdrop">
          <div class="inwin-modal">
            <div class="inwin-modal-header">
              <span>📜 Journaux d'exécution — ${escapeHtml(job.title)}</span>
              <button type="button" class="btn-xs" id="closeHistBtn">Fermer</button>
            </div>
            <div class="inwin-modal-body">
              ${logs.length === 0 ? `<div style="color:var(--os-text-secondary);">Aucune exécution enregistrée pour cette tâche.</div>` : logs.map((l) => `
                <div class="settings-card" style="padding:12px 14px;">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <span style="font-family:var(--font-mono);font-size:0.76rem;">${escapeHtml(l.started_at)} (${escapeHtml(l.triggered_by)})</span>
                    <div style="display:flex;gap:8px;align-items:center;">
                      <span class="status-pill-sm ${Number(l.exit_code) === 0 ? 'status-running' : 'status-error'}">
                        Code ${l.exit_code} · ${l.duration_ms} ms
                      </span>
                      ${Number(l.exit_code) !== 0 ? `<button type="button" class="btn-xs ai-diag" data-diag-log="${escapeHtml(l.output || '')}">✨ Diagnostiquer</button>` : ''}
                    </div>
                  </div>
                  <pre class="log-console selectable" style="max-height:160px;">${escapeHtml(l.output || '(Aucune sortie stdout/stderr)')}</pre>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      `;

      modalSlot.querySelector('#closeHistBtn').addEventListener('click', () => { modalSlot.innerHTML = ''; });
      modalSlot.querySelectorAll('[data-diag-log]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const out = btn.dataset.diagLog;
          modalSlot.innerHTML = '';
          window.__VANILLIA_DESKTOP__?.launchAppById('vanill-ia-chat', {
            context_type: 'cron_diag',
            target: `${job.title} (${job.command})`,
            logs: `Commande: ${job.command}\nUtilisateur: ${job.run_user}\n\nSortie:\n${out}`,
          });
        });
      });
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  const onLangChanged = () => renderMain();
  window.addEventListener('vanillia:lang-changed', onLangChanged);

  await loadJobs();
  return {
    cleanup() {
      window.removeEventListener('vanillia:lang-changed', onLangChanged);
    },
  };
}
