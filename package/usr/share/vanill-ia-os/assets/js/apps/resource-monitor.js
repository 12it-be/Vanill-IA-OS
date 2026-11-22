/**
 * ==============================================================================
 * Vanill-IA OS — Real-Time Hardware Resource Monitor & SMART Disk Health
 * Live SVG Sparklines, Per-Core CPU, Memory/Swap breakdown, Network RX/TX rates,
 * thermal sensors (`lm-sensors`) & physical disk diagnostics (`smartctl --json`)
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
  if (n < 1024) return `${n} o`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} Ko`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} Mo`;
  return `${(n / 1073741824).toFixed(2)} Go`;
}

function formatRate(bps) {
  return `${formatBytes(bps)}/s`;
}

function formatUptime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}j ${h}h ${m}m` : `${h}h ${m}m`;
}

/**
 * Génère un graphique vectoriel SVG lisse (Area + Stroke) sur 60 points.
 */
function buildAreaChartSvg(series, { maxVal = 100, stroke = '#FF6D5A', fillId = 'gradCpu' } = {}) {
  const w = 520;
  const h = 120;
  const pts = series.length > 0 ? series : [0];
  const padded = pts.length < 60 ? [...Array(60 - pts.length).fill(0), ...pts] : pts.slice(-60);
  const safeMax = Math.max(1, maxVal);

  const coords = padded.map((v, idx) => {
    const x = (idx / 59) * w;
    const clamped = Math.max(0, Math.min(safeMax, Number(v) || 0));
    const y = h - 6 - (clamped / safeMax) * (h - 14);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const linePath = `M ${coords.join(' L ')}`;
  const areaPath = `${linePath} L ${w},${h} L 0,${h} Z`;

  return `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:125px;display:block;border-radius:10px;background:rgba(0,0,0,0.16);">
      <defs>
        <linearGradient id="${fillId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${stroke}" stop-opacity="0.38"/>
          <stop offset="100%" stop-color="${stroke}" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      <line x1="0" y1="${h * 0.25}" x2="${w}" y2="${h * 0.25}" stroke="rgba(255,255,255,0.05)" stroke-dasharray="4 4"/>
      <line x1="0" y1="${h * 0.50}" x2="${w}" y2="${h * 0.50}" stroke="rgba(255,255,255,0.05)" stroke-dasharray="4 4"/>
      <line x1="0" y1="${h * 0.75}" x2="${w}" y2="${h * 0.75}" stroke="rgba(255,255,255,0.05)" stroke-dasharray="4 4"/>
      <path d="${areaPath}" fill="url(#${fillId})"/>
      <path d="${linePath}" fill="none" stroke="${stroke}" stroke-width="2.2" stroke-linejoin="round"/>
    </svg>
  `;
}

export async function mountApp({ container, api }) {
  let activeTab = 'live';
  let timer = null;

  const history = {
    cpu: [],
    ram: [],
    netRx: [],
    netTx: [],
  };

  let latestData = null;
  let smartData = null;

  container.innerHTML = `
    <div class="module-layout">
      <aside class="module-sidebar">
        <button type="button" class="module-nav-btn active" data-rmtab="live">📈 <span data-i18n="monitor.tab_live">${escapeHtml(t('monitor.tab_live'))}</span></button>
        <button type="button" class="module-nav-btn" data-rmtab="disks">💽 <span data-i18n="monitor.tab_disks">${escapeHtml(t('monitor.tab_disks'))}</span></button>
      </aside>
      <div class="module-content" id="rmContent"></div>
    </div>
  `;

  const contentEl = container.querySelector('#rmContent');

  container.querySelectorAll('[data-rmtab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.rmtab;
      container.querySelectorAll('[data-rmtab]').forEach((b) => b.classList.toggle('active', b === btn));
      if (activeTab === 'live') {
        renderLiveTab();
      } else {
        fetchSmartTab();
      }
    });
  });

  async function sampleMetrics() {
    try {
      latestData = await api.get('/api/system.php?action=metrics_full');
      const m = latestData.metrics || {};
      history.cpu.push(Number(m.cpu?.total_percent || 0));
      history.ram.push(Number(m.memory?.used_percent || 0));
      history.netRx.push(Number(m.network?.rx_rate_bps || 0));
      history.netTx.push(Number(m.network?.tx_rate_bps || 0));

      if (history.cpu.length > 60) history.cpu.shift();
      if (history.ram.length > 60) history.ram.shift();
      if (history.netRx.length > 60) history.netRx.shift();
      if (history.netTx.length > 60) history.netTx.shift();

      if (activeTab === 'live') {
        renderLiveTab();
      }
    } catch (err) {
      contentEl.innerHTML = `<div class="os-alert os-alert-error">${escapeHtml(err.message)}</div>`;
    }
  }

  function renderLiveTab() {
    if (!latestData) {
      contentEl.innerHTML = `<div class="settings-card">Échantillonnage des capteurs système...</div>`;
      return;
    }

    const info = latestData.info || {};
    const m = latestData.metrics || {};
    const cpuPct = Number(m.cpu?.total_percent || 0);
    const cores = m.cpu?.cores || {};
    const mem = m.memory || {};
    const load = m.load_average || {};
    const net = m.network || {};
    const temps = m.temperatures || [];
    const disks = m.disks || [];

    const maxNet = Math.max(10240, ...history.netRx, ...history.netTx);

    contentEl.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">${escapeHtml(t('monitor.cpu_load'))}</div>
          <div class="kpi-value" style="color:var(--os-accent)">${cpuPct.toFixed(1)}%</div>
          <div class="kpi-sub">Load ${load['1m'] ?? 0} · ${load['5m'] ?? 0} · ${load['15m'] ?? 0}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">${escapeHtml(t('monitor.ram_usage'))}</div>
          <div class="kpi-value" style="color:var(--os-info)">${Number(mem.used_percent || 0).toFixed(1)}%</div>
          <div class="kpi-sub">${formatBytes(mem.used)} / ${formatBytes(mem.total)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">${escapeHtml(t('monitor.net_live'))}</div>
          <div class="kpi-value" style="font-size:1.05rem;color:var(--os-success)">↓ ${formatRate(net.rx_rate_bps)}</div>
          <div class="kpi-sub">↑ ${formatRate(net.tx_rate_bps)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">${escapeHtml(t('monitor.uptime'))}</div>
          <div class="kpi-value" style="font-size:1.12rem;">${formatUptime(info.uptime_sec)}</div>
          <div class="kpi-sub">${escapeHtml(info.hostname || 'debian')} · ${load.processes || 0} proc.</div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:14px;">
        <div class="settings-card">
          <div class="toolbar-row" style="margin-bottom:8px;">
            <h3 style="margin:0;">${escapeHtml(t('monitor.cpu_history'))}</h3>
            <span style="font-family:var(--font-mono);font-size:0.78rem;color:var(--os-accent);">${escapeHtml(info.cpu_model || '')}</span>
          </div>
          ${buildAreaChartSvg(history.cpu, { maxVal: 100, stroke: '#FF6D5A', fillId: 'gradRmCpu' })}

          ${Object.keys(cores).length > 0 ? `
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(115px,1fr));gap:8px;margin-top:12px;">
              ${Object.entries(cores).map(([coreName, val]) => `
                <div style="font-family:var(--font-mono);font-size:0.73rem;">
                  <div style="display:flex;justify-content:space-between;margin-bottom:3px;">
                    <span>${escapeHtml(coreName.toUpperCase())}</span>
                    <span>${Number(val).toFixed(0)}%</span>
                  </div>
                  <div class="metric-bar" style="width:100%;height:6px;">
                    <span style="width:${Math.min(100, Number(val))}%;background:${Number(val) > 80 ? 'var(--os-danger)' : 'var(--os-accent)'}"></span>
                  </div>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>

        <div class="settings-card">
          <div class="toolbar-row" style="margin-bottom:8px;">
            <h3 style="margin:0;">Mémoire RAM & Swap</h3>
            <span style="font-family:var(--font-mono);font-size:0.78rem;color:var(--os-info);">Cache: ${formatBytes(mem.cached)}</span>
          </div>
          ${buildAreaChartSvg(history.ram, { maxVal: 100, stroke: '#0EA5E9', fillId: 'gradRmRam' })}

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px;font-size:0.79rem;">
            <div>Disponible : <strong>${formatBytes(mem.available)}</strong></div>
            <div>Buffers : <strong>${formatBytes(mem.buffers)}</strong></div>
            <div>Swap utilisé : <strong>${formatBytes(mem.swap_used)}</strong></div>
            <div>Swap total : <strong>${formatBytes(mem.swap_total)}</strong></div>
          </div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:14px;">
        <div class="settings-card">
          <div class="toolbar-row" style="margin-bottom:8px;">
            <h3 style="margin:0;">Débit Réseau Entrant (RX)</h3>
            <span style="font-family:var(--font-mono);font-size:0.76rem;color:var(--os-success);">Pic: ${formatRate(maxNet)}</span>
          </div>
          ${buildAreaChartSvg(history.netRx, { maxVal: maxNet, stroke: '#10B981', fillId: 'gradRmNet' })}
        </div>

        <div class="settings-card">
          <h3>Capteurs Thermiques (lm-sensors)</h3>
          ${temps.length === 0 ? `<p class="desc" style="margin-top:8px;">Aucune sonde matérielle détectée (VM ou conteneur virtualisé).</p>` : `
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(145px,1fr));gap:8px;margin-top:10px;">
              ${temps.map((t) => `
                <div style="padding:9px 11px;border-radius:11px;background:rgba(0,0,0,0.16);border:1px solid var(--os-border);">
                  <div style="font-size:0.73rem;color:var(--os-text-secondary);">${escapeHtml(t.label)}</div>
                  <div style="font-family:var(--font-mono);font-size:1.05rem;font-weight:700;color:${t.celsius >= 80 ? 'var(--os-danger)' : t.celsius >= 65 ? 'var(--os-warning)' : 'var(--os-success)'}">
                    ${Number(t.celsius).toFixed(1)} °C
                  </div>
                </div>
              `).join('')}
            </div>
          `}
        </div>
      </div>

      ${disks.length > 0 ? `
        <div class="settings-card">
          <h3>Systèmes de Fichiers Montés</h3>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;margin-top:10px;">
            ${disks.map((d) => `
              <div style="padding:12px;border-radius:12px;background:rgba(0,0,0,0.15);border:1px solid var(--os-border);">
                <div style="display:flex;justify-content:space-between;font-weight:600;margin-bottom:4px;">
                  <span>${escapeHtml(d.mountpoint)}</span>
                  <span style="font-family:var(--font-mono);">${d.used_percent}%</span>
                </div>
                <div class="metric-bar" style="width:100%;height:7px;margin-bottom:6px;">
                  <span style="width:${Math.min(100, d.used_percent)}%;background:${d.used_percent > 88 ? 'var(--os-danger)' : 'var(--os-info)'}"></span>
                </div>
                <div style="font-size:0.74rem;color:var(--os-text-secondary);font-family:var(--font-mono);">
                  ${formatBytes(d.used_bytes)} / ${formatBytes(d.total_bytes)} (${escapeHtml(d.fstype)})
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
    `;
  }

  async function fetchSmartTab() {
    contentEl.innerHTML = `<div class="settings-card">Interrogation SMART des disques physiques (smartctl)...</div>`;
    try {
      smartData = await api.get('/api/system.php?action=smart');
      const disks = smartData.disks || [];

      contentEl.innerHTML = `
        <div class="settings-card">
          <div class="toolbar-row">
            <div>
              <h3>Santé SMART des Disques Physiques</h3>
              <p class="desc" style="margin-bottom:0;">Diagnostic matériel direct via <code>smartmontools</code> (NVMe, SATA, SAS).</p>
            </div>
            <button type="button" class="btn-xs" id="refreshSmartBtn">↻ Relancer le test</button>
          </div>
        </div>

        ${disks.length === 0 ? `
          <div class="settings-card">
            <p class="desc" style="margin:0;">Aucun disque physique compatible SMART détecté (disque virtuel VirtIO/Proxmox ou environnement sans accès bloc).</p>
          </div>
        ` : `
          <div class="cards-grid">
            ${disks.map((d) => {
              const statusPill = d.healthy === true
                ? `<span class="status-pill-sm status-running">SAIN (PASSED)</span>`
                : d.healthy === false
                  ? `<span class="status-pill-sm status-error">ALERTE SMART</span>`
                  : `<span class="status-pill-sm status-stopped">N/A</span>`;

              return `
                <article class="entity-card">
                  <div style="display:flex;justify-content:space-between;align-items:center;">
                    <strong>${escapeHtml(d.model)}</strong>
                    ${statusPill}
                  </div>
                  <div style="font-family:var(--font-mono);font-size:0.76rem;color:var(--os-text-secondary);">
                    ${escapeHtml(d.path)} · ${escapeHtml(d.size || '')} · ${d.rotational ? 'HDD' : 'SSD/NVMe'}
                  </div>
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.8rem;padding-top:6px;border-top:1px solid var(--os-border);">
                    <div>Température : <strong>${d.temperature_c !== null ? `${d.temperature_c} °C` : '—'}</strong></div>
                    <div>Heures actif : <strong>${d.power_on_hours !== null ? `${d.power_on_hours} h` : '—'}</strong></div>
                    <div style="grid-column:1/-1;font-family:var(--font-mono);font-size:0.73rem;color:var(--os-text-muted);">S/N : ${escapeHtml(d.serial || 'Non communiqué')}</div>
                  </div>
                </article>
              `;
            }).join('')}
          </div>
        `}
      `;

      contentEl.querySelector('#refreshSmartBtn')?.addEventListener('click', fetchSmartTab);
    } catch (err) {
      contentEl.innerHTML = `<div class="os-alert os-alert-error">${escapeHtml(err.message)}</div>`;
    }
  }

  await sampleMetrics();
  timer = setInterval(() => {
    if (activeTab === 'live' && !document.hidden) {
      sampleMetrics();
    }
  }, 2500);

  const onLangChanged = () => {
    if (activeTab === 'live') renderLiveTab();
    else fetchSmartTab();
  };
  window.addEventListener('vanillia:lang-changed', onLangChanged);

  return {
    cleanup() {
      if (timer) clearInterval(timer);
      window.removeEventListener('vanillia:lang-changed', onLangChanged);
    },
  };
}
