/* ============================================
   BESALCO DASHBOARD — app.js
   Carga datos desde Firestore y renderiza el dashboard
   ============================================ */

// ---- Estado global ----
let _equipos  = [];
let _records  = [];
let _tank     = null;
let _equipoFilter = 'todos';

// ---- Charts ----
let chartDist      = null;
let chartFlota     = null;
let chartUltimas   = null;
let chartMant      = null;
let chartUsoMant   = null;

// ---- Navegación ----
function navigate(section) {
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.section === section);
  });
  document.querySelectorAll('.section').forEach(el => {
    el.classList.toggle('active', el.id === `section-${section}`);
  });

  const titles = {
    resumen:    ['Resumen General',         'Vista global de operaciones'],
    combustible:['Control de Combustible',  'Distribución y niveles de combustible'],
    equipos:    ['Gestión de Equipos',      'Estado y mantenimiento de la flota'],
    mantencion: ['Plan de Mantenimiento',   'Alertas y programación de servicios'],
    registros:  ['Registros de Distribución','Historial completo de despachos'],
  };
  const [h1, sub] = titles[section] || ['Dashboard', ''];
  document.getElementById('pageTitle').textContent    = h1;
  document.getElementById('pageSubtitle').textContent = sub;
}

document.querySelectorAll('.nav-item').forEach(el => {
  el.addEventListener('click', e => {
    e.preventDefault();
    navigate(el.dataset.section);
    if (window.innerWidth <= 768) {
      document.getElementById('sidebar').classList.remove('open');
    }
  });
});

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

// ---- Fecha topbar ----
function updateTopbarDate() {
  const now = new Date();
  document.getElementById('topbarDate').textContent =
    now.toLocaleDateString('es-CL', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
}

// ---- Helpers ----
function fmt(n, dec = 0) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('es-CL', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function fmtDate(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  return d.toLocaleDateString('es-CL');
}

function equipoNombre(id) {
  const e = _equipos.find(x => x.id === id);
  return e ? e.nombre : id;
}

function getPct(e) {
  const mant = e.mantencionCada;
  if (!mant) return null;
  if (e.unidadMantencion === 'km' && e.kmActual != null && e.kmUltimaMantencion != null) {
    return Math.abs((e.kmActual - e.kmUltimaMantencion) / mant) * 100;
  }
  if (e.horasActual != null && e.horasUltimaMantencion != null) {
    return Math.abs((e.horasActual - e.horasUltimaMantencion) / mant) * 100;
  }
  return null;
}

function getRestantes(e) {
  const mant = e.mantencionCada;
  if (!mant) return null;
  if (e.unidadMantencion === 'km' && e.kmActual != null && e.kmUltimaMantencion != null) {
    const r = (e.kmUltimaMantencion + mant) - e.kmActual;
    return r > 0 ? r : 0;
  }
  if (e.horasActual != null && e.horasUltimaMantencion != null) {
    const r = (e.horasUltimaMantencion + mant) - e.horasActual;
    return r > 0 ? r : 0;
  }
  return null;
}

// Proyecta la fecha en que se alcanzará el 95% del intervalo de mantención.
// Usa la tasa de avance diaria calculada desde los registros de combustible del equipo.
function getProyeccion(e, umbral = 0.95) {
  if (!e.mantencionCada) return null;
  const base    = e.unidadMantencion === 'km' ? e.kmUltimaMantencion  : e.horasUltimaMantencion;
  const actual  = e.unidadMantencion === 'km' ? e.kmActual            : e.horasActual;
  if (base == null || actual == null) return null;

  const meta = base + e.mantencionCada * umbral;
  if (actual >= meta) return new Date(); // ya superado

  const restante = meta - actual;

  const registros = _records
    .filter(r => r.equipoId === e.id)
    .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));

  if (registros.length < 2) return null;

  const primerMedidor = registros[0].kmOHoras;
  const ultimoMedidor = registros[registros.length - 1].kmOHoras;
  const dias = (new Date(registros[registros.length - 1].fecha) - new Date(registros[0].fecha))
               / (1000 * 60 * 60 * 24);

  if (dias <= 0 || ultimoMedidor <= primerMedidor) return null;

  const tasaPorDia = (ultimoMedidor - primerMedidor) / dias;
  if (tasaPorDia <= 0) return null;

  const diasRestantes = Math.ceil(restante / tasaPorDia);
  const fecha = new Date();
  fecha.setDate(fecha.getDate() + diasRestantes);
  return fecha;
}

function fuenteBadge(fuente) {
  if (fuente === 'copec') {
    return '<span style="background:#F39C12;color:#fff;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:600">COPEC</span>';
  }
  return '<span style="background:#1F4E8F;color:#fff;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:600">Cisterna</span>';
}

// ---- Firestore loader ----
async function waitForFirestore(timeout = 5000) {
  const start = Date.now();
  while (!window.__firebase_ready || !window.__firestore_db) {
    if (Date.now() - start > timeout) throw new Error('Firebase not ready');
    await new Promise(r => setTimeout(r, 50));
  }
  return window.__firestore_db;
}

async function loadDashboard() {
  document.getElementById('loadingOverlay').classList.remove('hidden');
  try {
    const db = await waitForFirestore();

    const [eqSnap, recSnap, tankSnap] = await Promise.all([
      db.collection('equipos').get(),
      db.collection('fuel_records').orderBy('fecha', 'desc').get(),
      db.collection('fuel_tanks').limit(1).get(),
    ]);

    _equipos = eqSnap.docs.map(d => d.data());
    _records = recSnap.docs.map(d => d.data());
    _tank    = tankSnap.docs.length ? tankSnap.docs[0].data() : null;

    renderAll();

    const now = new Date();
    document.getElementById('lastUpdate').textContent =
      'Actualizado ' + now.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });

  } catch (err) {
    console.error('Error cargando datos:', err);
    document.getElementById('lastUpdate').textContent = 'Error al cargar';
    alert('Error al conectar con Firebase: ' + err.message);
  } finally {
    document.getElementById('loadingOverlay').classList.add('hidden');
  }
}

function renderAll() {
  renderKPIs();
  renderChartDistribucion();
  renderChartFlota();
  renderAlerts();
  renderTankSection();
  renderChartUltimas();
  renderTableRecords();
  renderEquipos();
  renderMantencionSection();
  renderRegistrosSection();
}

// ---- KPIs ----
function renderKPIs() {
  const totalLitros = _records.reduce((s, r) => s + (r.litriosIngresados || 0), 0);
  const activos     = _equipos.filter(e => e.estado === 'activo').length;
  const combustible = _tank?.combustibleActual ?? 0;

  const urgentes = _equipos.filter(e => {
    const pct = getPct(e);
    return pct != null && pct >= 100;
  });
  const proximos = _equipos.filter(e => {
    const pct = getPct(e);
    return pct != null && pct >= 80 && pct < 100;
  });
  const tanqueAlerta = _tank && (_tank.combustibleActual / _tank.capacidadMaxima) * 100 < 20;
  const totalMantAlertas = urgentes.length + proximos.length + (tanqueAlerta ? 1 : 0);

  document.getElementById('kpiTotalLitros').textContent       = fmt(totalLitros);
  document.getElementById('kpiEquiposActivos').textContent    = activos;
  document.getElementById('kpiCombustibleActual').textContent = fmt(combustible);
  document.getElementById('kpiEquiposMantencion').textContent = totalMantAlertas;
}

// ---- Chart: Distribución por equipo (apilado cisterna + COPEC) ----
function renderChartDistribucion() {
  const totalesCisterna = {};
  const totalesCopec    = {};

  _records.forEach(r => {
    if (r.fuente === 'copec') {
      totalesCopec[r.equipoId] = (totalesCopec[r.equipoId] || 0) + (r.litriosIngresados || 0);
    } else {
      totalesCisterna[r.equipoId] = (totalesCisterna[r.equipoId] || 0) + (r.litriosIngresados || 0);
    }
  });

  const allIds = [...new Set([...Object.keys(totalesCisterna), ...Object.keys(totalesCopec)])];
  const sorted = allIds
    .map(id => ({ id, total: (totalesCisterna[id] || 0) + (totalesCopec[id] || 0) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  const labels = sorted.map(({ id }) => {
    const e = _equipos.find(x => x.id === id);
    return e ? `${e.nombre} (${e.patente})` : id.slice(0, 8);
  });

  const ctx = document.getElementById('chartDistribucion').getContext('2d');
  if (chartDist) chartDist.destroy();
  chartDist = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Cisterna',
          data: sorted.map(({ id }) => Math.round(totalesCisterna[id] || 0)),
          backgroundColor: '#003478',
          borderRadius: 4,
          borderSkipped: false,
        },
        {
          label: 'COPEC',
          data: sorted.map(({ id }) => Math.round(totalesCopec[id] || 0)),
          backgroundColor: '#F39C12',
          borderRadius: 4,
          borderSkipped: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 12, font: { size: 12 } } },
      },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: {
          stacked: true,
          beginAtZero: true,
          grid: { color: '#F0F0F0' },
          ticks: { callback: v => fmt(v) + ' Lt' },
        },
      },
    },
  });
}

// ---- Chart: Estado de flota (doughnut) ----
function renderChartFlota() {
  const activos   = _equipos.filter(e => e.estado === 'activo').length;
  const mant      = _equipos.filter(e => e.estado === 'mantencion').length;
  const fuera     = _equipos.filter(e => e.estado === 'fuera_servicio').length;
  const total     = _equipos.length;

  document.getElementById('dcTotal').textContent = total;

  const ctx = document.getElementById('chartEstadoFlota').getContext('2d');
  if (chartFlota) chartFlota.destroy();
  chartFlota = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Activos', 'En Mantención', 'Fuera de Servicio'],
      datasets: [{
        data: [activos, mant, fuera],
        backgroundColor: ['#27AE60', '#F39C12', '#E74C3C'],
        borderWidth: 0,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '68%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { boxWidth: 10, padding: 14, font: { size: 12 } },
        },
      },
    },
  });
}

// ---- Alertas ----
function renderAlerts() {
  const urgentes = _equipos.filter(e => {
    const pct = getPct(e);
    return pct != null && pct >= 100;
  });
  const proximos = _equipos.filter(e => {
    const pct = getPct(e);
    return pct != null && pct >= 80 && pct < 100;
  });
  const tankLow = _tank && (_tank.combustibleActual / _tank.capacidadMaxima) * 100 < 20;

  const total = urgentes.length + proximos.length + (tankLow ? 1 : 0);
  document.getElementById('badgeAlertas').textContent = total;

  const list = document.getElementById('alertasList');

  if (total === 0) {
    list.innerHTML = '<p class="no-alerts">✓ Sin alertas activas — todo en orden.</p>';
    return;
  }

  const items = [];

  if (tankLow) {
    const pct = ((_tank.combustibleActual / _tank.capacidadMaxima) * 100).toFixed(0);
    items.push(alertHTML('grave', 'local_gas', 'GRAVE', 'Combustible bajo en tanque',
      `Nivel actual: ${fmt(_tank.combustibleActual)} Lt (${pct}%). Se requiere recarga urgente.`));
  }

  urgentes.forEach(e => {
    const pct = getPct(e);
    items.push(alertHTML('grave', 'build', 'GRAVE',
      `Mantenimiento vencido: ${e.nombre}`,
      `${e.patente} · ${e.codigo} · ${pct?.toFixed(0) ?? '—'}% de uso`));
  });

  proximos.forEach(e => {
    const pct  = getPct(e);
    const rest = getRestantes(e);
    const unidad = e.unidadMantencion === 'km' ? 'km' : 'horas';
    items.push(alertHTML('leve', 'schedule', 'LEVE',
      `Próxima mantención: ${e.nombre}`,
      `${e.patente} · ${rest != null ? fmt(rest) + ' ' + unidad + ' restantes · ' : ''}${pct?.toFixed(0) ?? '—'}% de uso`));
  });

  list.innerHTML = items.join('');
}

function alertHTML(cls, iconName, nivel, titulo, sub) {
  const iconSvg = {
    local_gas: '<path d="M19.77 7.23l.01-.01-3.72-3.72L15 4.56l2.11 2.11c-.94.36-1.61 1.26-1.61 2.33 0 1.38 1.12 2.5 2.5 2.5.36 0 .69-.08 1-.21v7.21c0 .55-.45 1-1 1s-1-.45-1-1V14c0-1.1-.9-2-2-2h-1V5c0-1.1-.9-2-2-2H6c-1.1 0-2 .9-2 2v16h10v-7.5h1.5v5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V9c0-.69-.28-1.32-.73-1.77zM8 18v-4.5H6L10 6v5h2l-4 7z"/>',
    build:     '<path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/>',
    schedule:  '<path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"/>',
  }[iconName] || '';

  return `
    <div class="alert-item ${cls}">
      <div class="alert-icon"><svg viewBox="0 0 24 24">${iconSvg}</svg></div>
      <div class="alert-body">
        <div class="alert-title">${titulo}</div>
        <div class="alert-sub">${sub}</div>
      </div>
      <span class="alert-badge">${nivel}</span>
    </div>`;
}

// ---- Tank section ----
function renderTankSection() {
  if (!_tank) {
    ['tankPatente','tankModelo','tankCapacidad','tankActual','tankTotalDist','tankPct']
      .forEach(id => document.getElementById(id).textContent = 'No configurado');
    return;
  }

  const pct = (_tank.combustibleActual / _tank.capacidadMaxima) * 100;
  const low = pct < 20;

  document.getElementById('tankPatente').textContent   = _tank.patente  || '—';
  document.getElementById('tankModelo').textContent    = _tank.modelo   || '—';
  document.getElementById('tankCapacidad').textContent = fmt(_tank.capacidadMaxima) + ' Lt';
  document.getElementById('tankActual').textContent    = fmt(_tank.combustibleActual) + ' Lt';
  document.getElementById('tankTotalDist').textContent = fmt(_tank.totalDistribuido) + ' Lt';
  document.getElementById('tankPct').textContent       = pct.toFixed(1) + '%';

  const fill = document.getElementById('tankGaugeFill');
  fill.style.width = Math.min(pct, 100).toFixed(1) + '%';
  fill.classList.toggle('low', low);

  const badge = document.getElementById('tankStatusBadge');
  if (low) {
    badge.textContent = 'BAJO — Recarga urgente';
    badge.classList.add('low');
  } else {
    badge.textContent = 'Normal';
    badge.classList.remove('low');
  }

  document.getElementById('badgeRegistros').textContent = _records.length + ' registros';
}

// ---- Chart: Últimas distribuciones ----
function renderChartUltimas() {
  const last15 = [..._records].slice(0, 15).reverse();
  const labels = last15.map(r => {
    const d = new Date(r.fecha);
    return d.toLocaleDateString('es-CL', { day:'2-digit', month:'2-digit' });
  });
  const data = last15.map(r => r.litriosIngresados || 0);

  const ctx = document.getElementById('chartUltimas').getContext('2d');
  if (chartUltimas) chartUltimas.destroy();
  chartUltimas = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Litros despachados',
        data,
        borderColor: '#003478',
        backgroundColor: 'rgba(0,52,120,0.08)',
        borderWidth: 2,
        fill: true,
        tension: 0.4,
        pointRadius: 4,
        pointBackgroundColor: '#003478',
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          beginAtZero: true,
          grid: { color: '#F0F0F0' },
          ticks: { callback: v => fmt(v) + ' Lt' },
        },
        x: { grid: { display: false } },
      },
    },
  });
}

// ---- Table: Registros en sección combustible ----
let _recordsFiltered = [];

function renderTableRecords() {
  _recordsFiltered = [..._records];
  renderTbodyRecords();
}

function filterRecords() {
  const q = document.getElementById('searchRecords').value.toLowerCase();
  _recordsFiltered = _records.filter(r =>
    (r.equipoNombre || '').toLowerCase().includes(q) ||
    (r.operador     || '').toLowerCase().includes(q) ||
    (r.equipoPatente || '').toLowerCase().includes(q)
  );
  renderTbodyRecords();
}

function renderTbodyRecords() {
  const tbody = document.getElementById('tbodyRecords');
  if (!_recordsFiltered.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="td-loading">Sin registros</td></tr>';
    return;
  }
  tbody.innerHTML = _recordsFiltered.slice(0, 50).map(r => `
    <tr>
      <td>${fmtDate(r.fecha)}</td>
      <td>${r.equipoNombre || '—'}</td>
      <td>${r.equipoPatente || '—'}</td>
      <td><strong>${fmt(r.litriosIngresados, 1)} Lt</strong></td>
      <td>${fmt(r.kmOHoras, 0)} ${r.tipoUnidad || ''}</td>
      <td>${fuenteBadge(r.fuente)}</td>
      <td>${r.operador || '—'}</td>
    </tr>`).join('');
}

// ---- Equipos section ----
function filterEquipos(btn) {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _equipoFilter = btn.dataset.filter;
  renderEquipos();
}

function filterEquiposText() {
  renderEquipos();
}

function renderEquipos() {
  const q = (document.getElementById('searchEquipos')?.value || '').toLowerCase();
  const grid = document.getElementById('equiposGrid');

  let lista = [..._equipos];
  if (_equipoFilter !== 'todos') {
    lista = lista.filter(e => e.estado === _equipoFilter);
  }
  if (q) {
    lista = lista.filter(e =>
      (e.nombre   || '').toLowerCase().includes(q) ||
      (e.patente  || '').toLowerCase().includes(q) ||
      (e.codigo   || '').toLowerCase().includes(q)
    );
  }

  if (!lista.length) {
    grid.innerHTML = '<p class="loading-text">No hay equipos con ese filtro.</p>';
    return;
  }

  grid.innerHTML = lista.map(e => {
    const pct  = getPct(e);
    const pctVal = pct != null ? Math.min(pct, 120) : 0;
    const pctCls = pctVal >= 100 ? 'danger' : pctVal >= 80 ? 'warn' : '';
    const estadoCls = e.estado === 'mantencion' ? 'badge-mant' :
                      e.estado === 'fuera_servicio' ? 'badge-fuera' : 'badge-activo';
    const estadoText = e.estado === 'mantencion' ? 'En Mantención' :
                       e.estado === 'fuera_servicio' ? 'Fuera de Servicio' : 'Activo';
    const cardCls = e.estado === 'mantencion' ? 'mantencion' :
                    e.estado === 'fuera_servicio' ? 'fuera_servicio' : '';

    return `
      <div class="equipo-card ${cardCls}">
        <div class="equipo-header">
          <div>
            <div class="equipo-nombre">${e.nombre}</div>
            <div class="equipo-codigo">${e.codigo} · ${e.patente}</div>
          </div>
          <span class="estado-badge ${estadoCls}">${estadoText}</span>
        </div>
        <div class="equipo-info">
          <span>Tipo: ${e.tipo}</span>
          <span>Marca/Modelo: ${e.marca} ${e.modelo}</span>
          ${e.kmActual  != null ? `<span>KM actual: ${fmt(e.kmActual, 0)}</span>` : ''}
          ${e.horasActual != null ? `<span>Horas actuales: ${fmt(e.horasActual, 0)}</span>` : ''}
          ${e.mantencionCada ? `<span>Mantención cada: ${fmt(e.mantencionCada, 0)} ${e.unidadMantencion}</span>` : ''}
        </div>
        ${pct != null ? `
        <div class="equipo-progress-label">
          <span>Uso mantenimiento</span>
          <span>${pct.toFixed(0)}%</span>
        </div>
        <div class="equipo-progress-bar">
          <div class="equipo-progress-fill ${pctCls}" style="width:${Math.min(pctVal, 100).toFixed(1)}%"></div>
        </div>` : ''}
      </div>`;
  }).join('');
}

// ---- Mantencion section ----
function renderMantencionSection() {
  renderChartMantencion();
  renderChartUsoMantencion();
  renderTableMantencion();
}

function renderChartMantencion() {
  const ok      = _equipos.filter(e => { const p = getPct(e); return p == null || p < 80; }).length;
  const proximos = _equipos.filter(e => { const p = getPct(e); return p != null && p >= 80 && p < 100; }).length;
  const urgentes = _equipos.filter(e => { const p = getPct(e); return p != null && p >= 100; }).length;

  const ctx = document.getElementById('chartMantencion').getContext('2d');
  if (chartMant) chartMant.destroy();
  chartMant = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Al día', 'Próximos (80–99%)', 'Urgentes (≥100%)'],
      datasets: [{
        data: [ok, proximos, urgentes],
        backgroundColor: ['#27AE60', '#F39C12', '#E74C3C'],
        borderWidth: 0,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '60%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { boxWidth: 10, padding: 14, font: { size: 12 } },
        },
      },
    },
  });
}

function renderChartUsoMantencion() {
  const data = _equipos
    .map(e => ({ nombre: `${e.nombre} (${e.patente})`, pct: getPct(e) ?? 0 }))
    .filter(x => x.pct > 0)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 10);

  const ctx = document.getElementById('chartUsoMantencion').getContext('2d');
  if (chartUsoMant) chartUsoMant.destroy();
  chartUsoMant = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.map(d => d.nombre),
      datasets: [{
        label: '% uso',
        data: data.map(d => Math.min(d.pct, 120)),
        backgroundColor: data.map(d =>
          d.pct >= 100 ? '#E74C3C' : d.pct >= 80 ? '#F39C12' : '#27AE60'),
        borderRadius: 6,
        borderSkipped: false,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          min: 0, max: 120,
          grid: { color: '#F0F0F0' },
          ticks: { callback: v => v + '%' },
        },
        y: { grid: { display: false } },
      },
    },
  });
}

function renderTableMantencion() {
  const alertas = _equipos
    .map(e => ({ e, pct: getPct(e) }))
    .filter(({ pct }) => pct != null && pct >= 80)
    .sort((a, b) => b.pct - a.pct);

  const tbody = document.getElementById('tbodyMantencion');
  if (!alertas.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="td-loading">Sin equipos con alertas de mantenimiento</td></tr>';
    return;
  }

  tbody.innerHTML = alertas.map(({ e, pct }) => {
    const rest = getRestantes(e);
    const unidad = e.unidadMantencion === 'km' ? 'km' : 'hrs';
    const pctCls = pct >= 100 ? 'pct-danger' : 'pct-warn';
    const estadoText = pct >= 100 ? 'URGENTE' : 'PRÓXIMO';
    const estadoCls  = pct >= 100 ? 'badge-fuera' : 'badge-mant';
    const proj = getProyeccion(e);
    const projStr = proj
      ? proj.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : '—';
    const projStyle = proj && pct < 100
      ? (proj - new Date() < 7 * 86400000 ? 'color:#E74C3C;font-weight:600' : 'color:#F39C12;font-weight:600')
      : '';
    return `
      <tr>
        <td><strong>${e.nombre}</strong></td>
        <td>${e.patente}</td>
        <td>${unidad}</td>
        <td><span class="pct-badge ${pctCls}">${pct.toFixed(0)}%</span></td>
        <td>${rest != null ? fmt(rest, 0) + ' ' + unidad : '—'}</td>
        <td style="${projStyle}">${projStr}</td>
        <td><span class="estado-badge ${estadoCls}">${estadoText}</span></td>
      </tr>`;
  }).join('');
}

// ---- Registros section ----
let _allRecordsFiltered = [];

function renderRegistrosSection() {
  const total         = _records.length;
  const litrosCisterna = _records.filter(r => (r.fuente || 'cisterna') !== 'copec')
                                  .reduce((s, r) => s + (r.litriosIngresados || 0), 0);
  const litrosCopec   = _records.filter(r => r.fuente === 'copec')
                                  .reduce((s, r) => s + (r.litriosIngresados || 0), 0);
  const ops           = new Set(_records.map(r => r.operador)).size;

  document.getElementById('kpiTotalRegistros').textContent  = total;
  document.getElementById('kpiLitrosCisterna').textContent  = fmt(litrosCisterna, 0);
  document.getElementById('kpiLitrosCopec').textContent     = fmt(litrosCopec, 0);
  document.getElementById('kpiOperadores').textContent      = ops;

  _allRecordsFiltered = [..._records];
  renderTbodyAllRecords();
}

function filterAllRecords() {
  const q = document.getElementById('searchAllRecords').value.toLowerCase();
  _allRecordsFiltered = _records.filter(r =>
    (r.equipoNombre || '').toLowerCase().includes(q) ||
    (r.operador     || '').toLowerCase().includes(q) ||
    (r.equipoPatente || '').toLowerCase().includes(q) ||
    (r.notas        || '').toLowerCase().includes(q)
  );
  renderTbodyAllRecords();
}

function renderTbodyAllRecords() {
  const tbody = document.getElementById('tbodyAllRecords');
  if (!_allRecordsFiltered.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="td-loading">Sin registros</td></tr>';
    return;
  }
  tbody.innerHTML = _allRecordsFiltered.slice(0, 100).map(r => `
    <tr>
      <td>${fmtDate(r.fecha)}</td>
      <td>${r.equipoNombre || '—'}</td>
      <td>${r.equipoPatente || '—'}</td>
      <td><strong>${fmt(r.litriosIngresados, 1)} Lt</strong></td>
      <td>${fmt(r.kmOHoras, 0)} ${r.tipoUnidad || ''}</td>
      <td>${fuenteBadge(r.fuente)}</td>
      <td>${r.operador || '—'}</td>
      <td style="max-width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${r.notas || '—'}</td>
    </tr>`).join('');
}

// ---- Inicializar ----
updateTopbarDate();
document.getElementById('loadingOverlay').classList.remove('hidden');

// Espera a que firebase-config.js (type=module) exporte el db
window.addEventListener('load', () => {
  loadDashboard();
});
