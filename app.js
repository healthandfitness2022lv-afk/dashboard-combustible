/* ============================================
   BESALCO DASHBOARD — app.js
   Carga datos desde Firestore y renderiza el dashboard.
   Modelo de mantención: actual + próximo + frecuencia (km / horómetro / pluma).
   ============================================ */

// Entregado histórico previo a la app (al 20-jun-2026). El "Míter" parte de
// aquí y suma los movimientos registrados. Debe coincidir con el mismo valor
// en la app Flutter (AppProvider.acumuladoInicialEntregado).
const ACUM_INICIAL_ENTREGADO = 409867;

// ---- Estado global ----
let _equipos   = [];
let _records   = [];
let _tank      = null;
let _refills   = [];   // recargas del tanque (tank_refills)
let _returns   = [];   // devoluciones de externos (external_returns)
let _precioLitro = 0;  // CLP por litro (config)
let _empresasIncluidas = []; // empresas externas incluidas en el proyecto (no se cobran)
let _dailyReports = [];   // reportes diarios de operación (daily_reports)
let _factoresConfig = {}; // clasificación de tareas {tareaId: {noOperativa, usoEfectivo}}
let _maintenance = [];    // historial de mantenciones (maintenance_records)
let _equipoFilter = 'activo';
let _grupoFilter = 'todos'; // filtro por grupo de equipos
let _equipoSort = 'uso_desc'; // orden de la grilla de equipos

// Catálogo de tareas: id -> etiqueta (debe coincidir con tareas_operacion.dart).
const TAREAS_OPERACION = {
  panne: 'Panne',
  mantencion: 'Mantención',
  condicion_climatica: 'Condición climática',
  disponible_sin_operador: 'Disponible sin operador',
  disponible_con_postura: 'Disponible con postura',
  detencion_op_mlp: 'Detención op de MLP',
  detencion_documental: 'Detención documental',
  disponible_sin_postura: 'Disponible sin postura',
  acreditacion: 'Acreditación',
  cambio_turno: 'Cambio de turno',
  desmovilizado: 'Desmovilizado',
  operacion_horometro: 'Hrs máquina',
};
function etiquetaTarea(id) { return TAREAS_OPERACION[id] || id; }

// ---- Charts ----
let chartDist      = null;
let chartFlota     = null;
let chartMant      = null;
let chartUsoMant   = null;
let chartArea      = null;
let chartRefills   = null;
let chartNivelTanque = null;
let chartGrupos    = null;
let chartSubgrupo  = null;
let _grupoSeleccionadoSub = null; // grupo cuyo desglose de equipos se muestra
let chartFUFO      = null;
let chartDesglose  = null;

// ---- Navegación ----
function navigate(section) {
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.section === section);
  });
  document.querySelectorAll('.section').forEach(el => {
    el.classList.toggle('active', el.id === `section-${section}`);
  });

  const titles = {
    resumen:    ['Resumen General',          'Lo importante de un vistazo'],
    combustible:['Control de Combustible',   'Tanque, recargas y entregas'],
    equipos:    ['Gestión de Equipos',       'Estado y mantenimiento de la flota'],
    mantencion: ['Plan de Mantenimiento',    'Alertas y programación de servicios'],
    documentos: ['Documentación',            'Vencimientos de certificaciones'],
    externos:   ['Cuentas Externos',         'Deuda de combustible por empresa'],
    registros:  ['Registros de Distribución','Historial completo de despachos'],
    operacion:  ['Reportes Diarios',         'Horas trabajadas y factores por equipo'],
    factores:   ['Factores FU / FO',         'Utilización y operatividad por equipo'],
  };
  const [h1, sub] = titles[section] || ['Dashboard', ''];
  document.getElementById('pageTitle').textContent    = h1;
  document.getElementById('pageSubtitle').textContent = sub;

  // Al entrar a Combustible, refresca el chart (Chart.js no mide bien cuando
  // la sección estaba oculta) y el reporte del día.
  if (section === 'combustible') {
    if (typeof renderChartRefills === 'function') renderChartRefills();
    if (typeof renderChartNivelTanque === 'function') renderChartNivelTanque();
    if (typeof renderReporteCombustible === 'function') renderReporteCombustible();
  }
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

// ─────────────────────────────────────────────────────────────────────────
// MEDIDORES DE UN EQUIPO
// El modelo nuevo guarda, por cada medidor, la lectura actual, el "próximo"
// (valor al que toca la mantención) y la frecuencia (tamaño del ciclo).
// Un equipo puede tener km, horómetro, pluma o combinaciones (Camión Pluma).
// ─────────────────────────────────────────────────────────────────────────

function tieneKm(e)        { return e.kmActual != null || e.proximoKm != null; }
function tieneHorometro(e) { return e.horasActual != null || e.proximoHorometro != null; }
function tienePluma(e)     { return e.tienePluma === true; }

// % de uso de un medidor: ciclo = frecuencia; usado = frecuencia - (próximo - actual)
function pctMedidor(actual, proximo, frecuencia) {
  if (actual == null || proximo == null || !frecuencia) return null;
  const restante = proximo - actual;
  const usado = frecuencia - restante;
  return (usado / frecuencia) * 100;
}

function restanteMedidor(actual, proximo) {
  if (actual == null || proximo == null) return null;
  const r = proximo - actual;
  return r > 0 ? r : 0;
}

// Devuelve la lista de medidores aplicables de un equipo, cada uno con su
// estado de mantención. Tipo: 'km' | 'horometro' | 'pluma'.
// Nombres legibles de los tipos de equipo (coincide con la app).
const TIPOS_EQUIPO = {
  excavadora: 'Excavadora', pala: 'Pala', cargador: 'Cargador Frontal',
  perforadora: 'Perforadora', volqueta: 'Volqueta', grua: 'Grúa',
  ventilador: 'Ventilador', bomba: 'Bomba de Agua', compresor: 'Compresor',
  bidon: 'Bidón de Reserva', otro: 'Otro',
};
function tipoLegible(t) { return TIPOS_EQUIPO[t] || t || '—'; }

// Un bidón de reserva: equipo tipo 'bidon', sin medidores ni mantención.
function esBidon(e) { return e.tipo === 'bidon'; }

function medidoresDe(e) {
  const lista = [];
  if (tieneKm(e)) {
    lista.push({
      tipo: 'km', label: 'Kilometraje', unidad: 'km',
      actual: e.kmActual, proximo: e.proximoKm, frecuencia: e.frecuenciaKm,
      pct: pctMedidor(e.kmActual, e.proximoKm, e.frecuenciaKm),
      restante: restanteMedidor(e.kmActual, e.proximoKm),
    });
  }
  if (tieneHorometro(e)) {
    lista.push({
      tipo: 'horometro', label: 'Horómetro', unidad: 'h',
      actual: e.horasActual, proximo: e.proximoHorometro, frecuencia: e.frecuenciaHorometro,
      pct: pctMedidor(e.horasActual, e.proximoHorometro, e.frecuenciaHorometro),
      restante: restanteMedidor(e.horasActual, e.proximoHorometro),
    });
  }
  if (tienePluma(e)) {
    lista.push({
      tipo: 'pluma', label: 'Pluma', unidad: 'h',
      actual: e.horasPlumaActual, proximo: e.proximoHorometroPluma, frecuencia: e.frecuenciaPluma,
      pct: pctMedidor(e.horasPlumaActual, e.proximoHorometroPluma, e.frecuenciaPluma),
      restante: restanteMedidor(e.horasPlumaActual, e.proximoHorometroPluma),
    });
  }
  return lista;
}

// % de uso "principal" del equipo: el MÁS crítico (mayor %) entre sus medidores.
function getPct(e) {
  const pcts = medidoresDe(e).map(m => m.pct).filter(p => p != null);
  if (!pcts.length) return null;
  return Math.max(...pcts);
}

// % de uso para ALERTAS de mantención: los equipos dados de baja no alertan.
function getPctAlerta(e) {
  if (e.estado === 'baja') return null;
  return getPct(e);
}

// True si el equipo tiene al menos un documento vencido (fecha ya pasada).
function tieneDocVencido(e) {
  const ahora = new Date();
  const docs = e.documentos || {};
  return Object.values(docs).some(info => {
    const esObj = info && typeof info === 'object';
    if (esObj && info.noVence === true) return false;
    const venceStr = esObj ? info.vence : info;
    if (!venceStr) return false;
    return new Date(venceStr) < ahora;
  });
}

// Restante del medidor más crítico (el que está más cerca/pasado del límite).
function getMedidorCritico(e) {
  const ms = medidoresDe(e).filter(m => m.pct != null);
  if (!ms.length) return null;
  return ms.reduce((a, b) => (b.pct > a.pct ? b : a));
}

// Proyección de fecha hacia el 95% del ciclo, usando la tasa de avance del
// medidor crítico derivada de los registros de combustible del equipo.
function getProyeccion(e, umbral = 0.95) {
  const m = getMedidorCritico(e);
  if (!m || m.proximo == null || !m.frecuencia) return null;

  const meta = m.proximo - m.frecuencia * (1 - umbral);
  if (m.actual >= meta) return new Date();

  const restante = meta - m.actual;

  // Para km/horómetro principal usamos kmOHoras; para pluma, horometroPluma.
  const registros = _records
    .filter(r => r.equipoId === e.id && !r.esExterno)
    .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
  if (registros.length < 2) return null;

  const lectura = (r) => m.tipo === 'pluma' ? r.horometroPluma : r.kmOHoras;
  const primer = lectura(registros[0]);
  const ultimo = lectura(registros[registros.length - 1]);
  if (primer == null || ultimo == null) return null;

  const dias = (new Date(registros[registros.length - 1].fecha) - new Date(registros[0].fecha))
               / (1000 * 60 * 60 * 24);
  if (dias <= 0 || ultimo <= primer) return null;

  const tasaPorDia = (ultimo - primer) / dias;
  if (tasaPorDia <= 0) return null;

  const fecha = new Date();
  fecha.setDate(fecha.getDate() + Math.ceil(restante / tasaPorDia));
  return fecha;
}

// ---- Badges ----
function fuenteBadge(r) {
  if (r.esExterno) {
    return '<span class="src-badge src-ext">EXTERNO</span>';
  }
  if (r.fuente === 'copec') {
    return '<span class="src-badge src-copec">COPEC</span>';
  }
  return '<span class="src-badge src-cist">Cisterna</span>';
}

function areaBadge(area) {
  if (!area) return '—';
  return `<span class="area-badge">${area}</span>`;
}

// Texto descriptivo de la lectura de medidor de un registro.
function medidorRegistro(r) {
  if (r.esExterno) return '—';
  const partes = [];
  if (r.kmOHoras != null && r.kmOHoras !== 0) {
    partes.push(`${fmt(r.kmOHoras)} ${r.tipoUnidad || ''}`.trim());
  }
  if (r.horometroPluma != null) {
    partes.push(`Pluma ${fmt(r.horometroPluma)} h`);
  }
  return partes.length ? partes.join(' · ') : '—';
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

    const [eqSnap, recSnap, tankSnap, refSnap, retSnap, cfgSnap, extCfgSnap, drSnap, facCfgSnap, mntSnap] = await Promise.all([
      db.collection('equipos').get(),
      db.collection('fuel_records').orderBy('fecha', 'desc').get(),
      db.collection('fuel_tanks').limit(1).get(),
      db.collection('tank_refills').get().catch(() => ({ docs: [] })),
      db.collection('external_returns').get().catch(() => ({ docs: [] })),
      db.collection('config').doc('precios').get().catch(() => null),
      db.collection('config').doc('externos').get().catch(() => null),
      db.collection('daily_reports').get().catch(() => ({ docs: [] })),
      db.collection('config').doc('factores').get().catch(() => null),
      db.collection('maintenance_records').get().catch(() => ({ docs: [] })),
    ]);

    _equipos    = eqSnap.docs.map(d => d.data());
    _records    = recSnap.docs.map(d => d.data());
    _tank       = tankSnap.docs.length ? tankSnap.docs[0].data() : null;
    _refills    = refSnap.docs.map(d => d.data())
                    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
    _returns    = retSnap.docs.map(d => d.data());
    _precioLitro = (cfgSnap && cfgSnap.exists ? (cfgSnap.data().precioLitro || 0) : 0);
    _empresasIncluidas = (extCfgSnap && extCfgSnap.exists
      ? (extCfgSnap.data().empresasIncluidas || [])
      : []).map(s => String(s).trim());
    _dailyReports = drSnap.docs.map(d => d.data());
    // Clasificación de tareas. Si no hay config, el default de la app es
    // Panne y Mantención como "no operativas".
    const facData = (facCfgSnap && facCfgSnap.exists ? facCfgSnap.data() : null);
    _factoresConfig = (facData && facData.clasificacion && Object.keys(facData.clasificacion).length)
      ? facData.clasificacion
      : { panne: { noOperativa: true }, mantencion: { noOperativa: true } };
    _maintenance = mntSnap.docs.map(d => d.data())
                    .sort((a, b) => new Date(b.fechaMantencion) - new Date(a.fechaMantencion));

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
  renderChartArea();
  renderAlerts();
  renderTankSection();
  renderChartRefills();
  renderChartNivelTanque();
  renderTableRefills();
  initReporteCombustible();
  renderEquipos();
  renderChartGrupos();
  renderMantencionSection();
  renderDocumentos();
  renderExternos();
  renderRegistrosSection();
  renderOperacion();
  renderFactores();
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers de documentación y externos (datos nuevos del modelo).
// ─────────────────────────────────────────────────────────────────────────

// Documentos vencidos o por vencer (≤diasAviso) de todos los equipos.
function alertasDocumentos(diasAviso = 14) {
  const ahora = new Date();
  const out = [];
  _equipos.forEach(e => {
    const docs = e.documentos || {};
    Object.entries(docs).forEach(([nombre, info]) => {
      // info puede ser string (formato viejo) o {vence, fotoUrl, noVence}.
      const esObj = info && typeof info === 'object';
      // Documentos marcados como "no vence" (N/A) no generan alerta nunca.
      if (esObj && info.noVence === true) return;
      const venceStr = esObj ? info.vence : info;
      if (!venceStr) return;
      const vence = new Date(venceStr);
      const dias = Math.ceil((vence - ahora) / 86400000);
      if (dias <= diasAviso) {
        out.push({ equipo: e.nombre, patente: e.patente, documento: nombre,
                   vence, dias, vencido: dias < 0 });
      }
    });
  });
  return out.sort((a, b) => a.vence - b.vence);
}

function empresaIncluida(emp) {
  return _empresasIncluidas.includes((emp || '').trim());
}

// Saldo por empresa externa: entregado − devuelto (en litros) + valor $.
// Las empresas "incluidas en el proyecto" se cargan pero NO se cobran (monto 0).
function cuentasExternos() {
  const entregado = {}, devuelto = {};
  _records.forEach(r => {
    if (!r.esExterno) return;
    const emp = (r.empresaExterna || 'Sin empresa').trim();
    entregado[emp] = (entregado[emp] || 0) + (r.litriosIngresados || 0);
  });
  _returns.forEach(d => {
    const emp = (d.empresa || 'Sin empresa').trim();
    devuelto[emp] = (devuelto[emp] || 0) + (d.litros || 0);
  });
  const empresas = [...new Set([...Object.keys(entregado), ...Object.keys(devuelto)])];
  return empresas.map(emp => {
    const ent = entregado[emp] || 0, dev = devuelto[emp] || 0;
    const saldo = ent - dev;
    const incluida = empresaIncluida(emp);
    return { empresa: emp, entregado: ent, devuelto: dev, saldo, incluida,
             monto: incluida ? 0 : saldo * _precioLitro };
  }).sort((a, b) => b.saldo - a.saldo);
}

// ---- KPIs (Resumen): lo más accionable para jefatura ----
function renderKPIs() {
  // 1. Nivel del tanque (% + litros).
  const pctTanque = _tank ? (_tank.combustibleActual / _tank.capacidadMaxima) * 100 : 0;
  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

  setTxt('kpiTanquePct', _tank ? pctTanque.toFixed(0) + '%' : '—');
  setTxt('kpiTanqueLt', _tank ? `${fmt(_tank.combustibleActual)} / ${fmt(_tank.capacidadMaxima)} Lt` : 'Sin tanque');

  // 2. Míter: valor inicial histórico + movimientos registrados no-COPEC.
  // Bruto (no descuenta devueltos). Mismo cálculo que la app del operador.
  const miter = ACUM_INICIAL_ENTREGADO + _records
    .filter(r => (r.fuente || 'cisterna') !== 'copec')
    .reduce((s, r) => s + (r.litriosIngresados || 0), 0);
  setTxt('kpiTotalLitros', fmt(miter));

  // 3. Equipos en alerta de mantención (≥80%). Excluye dados de baja.
  const enAlerta = _equipos.filter(e => { const p = getPctAlerta(e); return p != null && p >= 80; }).length;
  setTxt('kpiEquiposMantencion', enAlerta);

  // 4. Documentos vencidos / por vencer (≤14 días).
  const docs = alertasDocumentos();
  const vencidos = docs.filter(d => d.vencido).length;
  setTxt('kpiDocsAlerta', docs.length);
  setTxt('kpiDocsDetalle', docs.length === 0
    ? 'Todo al día'
    : `${vencidos} vencido(s) · ${docs.length - vencidos} por vencer`);
}

// ---- Chart: Distribución por equipo (apilado cisterna + COPEC) ----
function renderChartDistribucion() {
  const totalesCisterna = {};
  const totalesCopec    = {};

  _records.forEach(r => {
    if (r.esExterno) return; // los externos van en su propio análisis
    const key = r.equipoId || r.equipoNombre;
    if (r.fuente === 'copec') {
      totalesCopec[key] = (totalesCopec[key] || 0) + (r.litriosIngresados || 0);
    } else {
      totalesCisterna[key] = (totalesCisterna[key] || 0) + (r.litriosIngresados || 0);
    }
  });

  const allIds = [...new Set([...Object.keys(totalesCisterna), ...Object.keys(totalesCopec)])];
  const sorted = allIds
    .map(id => ({ id, total: (totalesCisterna[id] || 0) + (totalesCopec[id] || 0) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  const labels = sorted.map(({ id }) => {
    const e = _equipos.find(x => x.id === id);
    return e ? `${e.nombre} (${e.patente})` : String(id).slice(0, 14);
  });

  const ctx = document.getElementById('chartDistribucion').getContext('2d');
  if (chartDist) chartDist.destroy();
  chartDist = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Cisterna', data: sorted.map(({ id }) => Math.round(totalesCisterna[id] || 0)),
          backgroundColor: '#003478', borderRadius: 4, borderSkipped: false },
        { label: 'COPEC', data: sorted.map(({ id }) => Math.round(totalesCopec[id] || 0)),
          backgroundColor: '#F39C12', borderRadius: 4, borderSkipped: false },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'top', labels: { boxWidth: 12, font: { size: 12 } } } },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: { stacked: true, beginAtZero: true, grid: { color: '#F0F0F0' },
             ticks: { callback: v => fmt(v) + ' Lt' } },
      },
    },
  });
}

// ---- Chart: Estado de flota (doughnut) ----
function renderChartFlota() {
  // Alineado con la app: Activos, Doc. vencida, Mant. vencida y Dados de Baja.
  const activos    = _equipos.filter(e => e.estado === 'activo').length;
  const docVenc    = _equipos.filter(e => tieneDocVencido(e)).length;
  const mantVenc   = _equipos.filter(e => { const p = getPctAlerta(e); return p != null && p >= 100; }).length;
  const baja       = _equipos.filter(e => e.estado === 'baja').length;

  document.getElementById('dcTotal').textContent = activos;

  const ctx = document.getElementById('chartEstadoFlota').getContext('2d');
  if (chartFlota) chartFlota.destroy();
  chartFlota = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Activos', 'Doc. Vencida', 'Mant. Vencida', 'Dados de Baja'],
      datasets: [{ data: [activos, docVenc, mantVenc, baja],
        backgroundColor: ['#27AE60', '#E67E22', '#E74C3C', '#7F8C8D'], borderWidth: 0, hoverOffset: 6 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '68%',
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, padding: 14, font: { size: 12 } } } },
    },
  });
}

// ---- Chart: Litros por Área de trabajo ----
function renderChartArea() {
  const ctx = document.getElementById('chartArea');
  if (!ctx) return;
  const porArea = {};
  _records.forEach(r => {
    const a = (r.areaTrabajo && r.areaTrabajo.trim()) ? r.areaTrabajo.trim() : 'Sin área';
    porArea[a] = (porArea[a] || 0) + (r.litriosIngresados || 0);
  });
  const entradas = Object.entries(porArea).sort((a, b) => b[1] - a[1]);

  if (chartArea) chartArea.destroy();
  chartArea = new Chart(ctx.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: entradas.map(e => e[0]),
      datasets: [{ data: entradas.map(e => Math.round(e[1])),
        backgroundColor: ['#003478', '#F39C12', '#27AE60', '#8E44AD', '#16A085', '#95A5A6'],
        borderWidth: 0, hoverOffset: 6 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '60%',
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, padding: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: c => `${c.label}: ${fmt(c.parsed)} Lt` } },
      },
    },
  });
}

// ---- Alertas (mantención + tanque + documentos) ----
function renderAlerts() {
  const urgentes = _equipos.filter(e => { const p = getPctAlerta(e); return p != null && p >= 100; });
  const proximos = _equipos.filter(e => { const p = getPctAlerta(e); return p != null && p >= 80 && p < 100; });
  const tankLow  = _tank && (_tank.combustibleActual / _tank.capacidadMaxima) * 100 < 20;
  const docs     = alertasDocumentos();

  const total = urgentes.length + proximos.length + docs.length + (tankLow ? 1 : 0);
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
    const m = getMedidorCritico(e);
    items.push(alertHTML('grave', 'build', 'GRAVE',
      `Mantenimiento vencido: ${e.nombre}`,
      `${e.patente} · ${m ? m.label + ' ' + (m.pct?.toFixed(0) ?? '—') + '%' : ''}`));
  });

  // Documentos: vencidos (grave) y por vencer (leve).
  docs.forEach(d => {
    const sub = d.vencido
      ? `${d.patente} · VENCIÓ ${d.vence.toLocaleDateString('es-CL')}`
      : `${d.patente} · vence en ${d.dias} día(s) (${d.vence.toLocaleDateString('es-CL')})`;
    items.push(alertHTML(d.vencido ? 'grave' : 'leve', 'doc',
      d.vencido ? 'VENCIDO' : 'POR VENCER',
      `${d.documento} · ${d.equipo}`, sub));
  });

  proximos.forEach(e => {
    const m = getMedidorCritico(e);
    items.push(alertHTML('leve', 'schedule', 'LEVE',
      `Próxima mantención: ${e.nombre}`,
      `${e.patente} · ${m && m.restante != null ? fmt(m.restante) + ' ' + m.unidad + ' restantes · ' : ''}${m ? m.pct?.toFixed(0) + '%' : ''}`));
  });

  list.innerHTML = items.join('');
}

function alertHTML(cls, iconName, nivel, titulo, sub) {
  const iconSvg = {
    local_gas: '<path d="M19.77 7.23l.01-.01-3.72-3.72L15 4.56l2.11 2.11c-.94.36-1.61 1.26-1.61 2.33 0 1.38 1.12 2.5 2.5 2.5.36 0 .69-.08 1-.21v7.21c0 .55-.45 1-1 1s-1-.45-1-1V14c0-1.1-.9-2-2-2h-1V5c0-1.1-.9-2-2-2H6c-1.1 0-2 .9-2 2v16h10v-7.5h1.5v5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V9c0-.69-.28-1.32-.73-1.77zM8 18v-4.5H6L10 6v5h2l-4 7z"/>',
    build:     '<path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/>',
    schedule:  '<path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"/>',
    doc:       '<path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>',
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
      .forEach(id => { const el = document.getElementById(id); if (el) el.textContent = 'No configurado'; });
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
  if (low) { badge.textContent = 'BAJO — Recarga urgente'; badge.classList.add('low'); }
  else     { badge.textContent = 'Normal'; badge.classList.remove('low'); }
}

// ---- Chart: Recargas del tanque (entradas) ----
function renderChartRefills() {
  const ctx = document.getElementById('chartRefills');
  if (!ctx) return;
  const sorted = [..._refills].sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
  const labels = sorted.map(r => new Date(r.fecha).toLocaleDateString('es-CL', { day:'2-digit', month:'2-digit' }));
  const data = sorted.map(r => r.litros || 0);

  if (chartRefills) chartRefills.destroy();
  chartRefills = new Chart(ctx.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: 'Litros recargados', data,
        backgroundColor: '#27AE60', borderRadius: 4, borderSkipped: false }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, grid: { color: '#F0F0F0' }, ticks: { callback: v => fmt(v) + ' Lt' } },
        x: { grid: { display: false } },
      },
    },
  });
}

// ---- Chart: Nivel del tanque en el tiempo (paso a paso) ----
// Reconstruye la curva del nivel del estanque. Como las entregas no guardan el
// nivel resultante, partimos del nivel ACTUAL conocido (_tank.combustibleActual)
// y caminamos hacia atrás aplicando cada evento en orden cronológico inverso:
//   · recarga  → el nivel sube (antes = después − litros recargados)
//   · entrega desde cisterna (fuente ≠ copec) → el nivel baja (antes = después + litros)
//   · entrega COPEC → no toca el tanque (se ignora)
// Así, si en un mismo día hubo recarga y entregas, se ven los escalones.
function renderChartNivelTanque() {
  const ctx = document.getElementById('chartNivelTanque');
  if (!ctx) return;
  if (chartNivelTanque) { chartNivelTanque.destroy(); chartNivelTanque = null; }

  if (!_tank) {
    return; // sin tanque configurado no hay nada que graficar
  }

  const desde = new Date();
  desde.setDate(desde.getDate() - 30);

  // Eventos que afectan el tanque: recargas (+) y entregas desde cisterna (−).
  const eventos = [];
  _refills.forEach(r => {
    eventos.push({ t: new Date(r.fecha), delta: +(r.litros || 0), tipo: 'recarga' });
  });
  _records.forEach(r => {
    if ((r.fuente || 'cisterna') === 'copec') return; // COPEC no sale del estanque
    eventos.push({ t: new Date(r.fecha), delta: -(r.litriosIngresados || 0), tipo: 'entrega' });
  });
  eventos.sort((a, b) => a.t - b.t); // cronológico ascendente

  // Reconstruir niveles hacia atrás desde el nivel actual.
  // Recorremos del último al primero: nivelAntes = nivelDespues − delta.
  const cap = _tank.capacidadMaxima || 0;
  let nivelDespues = _tank.combustibleActual || 0;
  const puntos = []; // {t, nivel}
  for (let i = eventos.length - 1; i >= 0; i--) {
    const ev = eventos[i];
    // Punto "después" del evento i.
    puntos.push({ t: ev.t, nivel: nivelDespues });
    // Nivel antes del evento (= después de aplicar al revés su delta).
    nivelDespues = nivelDespues - ev.delta;
  }
  puntos.reverse(); // ahora cronológico ascendente

  // Filtra a últimos 30 días.
  const visibles = puntos.filter(p => p.t >= desde);
  if (visibles.length < 2) {
    // Muy pocos datos en el rango: muestra al menos el nivel actual como línea plana.
    return;
  }

  const labels = visibles.map(p =>
    p.t.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit' }) + ' ' +
    p.t.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }));
  const data = visibles.map(p => Math.max(0, Math.round(p.nivel)));

  chartNivelTanque = new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Nivel del tanque',
        data,
        borderColor: '#1F6FEB',
        backgroundColor: 'rgba(31,111,235,0.12)',
        pointBackgroundColor: '#1F6FEB',
        pointBorderColor: '#ffffff',
        pointBorderWidth: 1.5,
        fill: true,
        stepped: false,
        tension: 0.15,
        pointRadius: 4,
        pointHoverRadius: 7,
        borderWidth: 2.5,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => `${fmt(c.parsed.y)} Lt` } },
      },
      scales: {
        y: {
          beginAtZero: true,
          suggestedMax: cap || undefined,
          grid: { color: '#F0F0F0' },
          ticks: { callback: v => fmt(v) + ' Lt' },
        },
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
      },
    },
  });
}

// ---- Tabla: Recargas del tanque ----
function renderTableRefills() {
  const tbody = document.getElementById('tbodyRefills');
  if (!tbody) return;
  if (!_refills.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="td-loading">Sin recargas registradas</td></tr>';
    return;
  }
  tbody.innerHTML = _refills.slice(0, 50).map(r => `
    <tr>
      <td>${fmtDate(r.fecha)}</td>
      <td><strong style="color:#27AE60">+${fmt(r.litros, 0)} Lt</strong></td>
      <td>${fmt(r.nivelResultante, 0)} Lt</td>
      <td>${r.operador || '—'}</td>
    </tr>`).join('');
}

// ---- Reporte diario de combustible ----
// Devuelve la fecha de un ISO como 'YYYY-MM-DD' (día local), para comparar.
function diaLocal(isoStr) {
  const d = new Date(isoStr);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d - off).toISOString().slice(0, 10);
}

// Inicializa el selector de fecha con el día de hoy (solo la primera vez) y
// pinta el reporte.
function initReporteCombustible() {
  const input = document.getElementById('fechaReporteComb');
  if (!input) return;
  if (!input.value) {
    input.value = new Date().toISOString().slice(0, 10);
  }
  renderReporteCombustible();
}

function cambiarDiaCombustible(delta) {
  const input = document.getElementById('fechaReporteComb');
  if (!input || !input.value) return;
  const d = new Date(input.value + 'T12:00:00'); // mediodía evita saltos por TZ
  d.setDate(d.getDate() + delta);
  input.value = d.toISOString().slice(0, 10);
  renderReporteCombustible();
}

function renderReporteCombustible() {
  const input = document.getElementById('fechaReporteComb');
  const tbody = document.getElementById('tbodyReporteComb');
  if (!input || !tbody) return;
  const dia = input.value;
  if (!dia) return;

  // Cargas de combustible de ese día.
  const cargas = _records
    .filter(r => diaLocal(r.fecha) === dia)
    .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));

  // Recargas al tanque de ese día.
  const recargas = _refills.filter(r => diaLocal(r.fecha) === dia);

  // Mini-KPIs. Besalco = todo lo no externo; Externos = MLP u otras empresas.
  const totalDia = cargas.reduce((s, r) => s + (r.litriosIngresados || 0), 0);
  const besalco = cargas.filter(r => !r.esExterno)
    .reduce((s, r) => s + (r.litriosIngresados || 0), 0);
  const externos = cargas.filter(r => r.esExterno)
    .reduce((s, r) => s + (r.litriosIngresados || 0), 0);
  const recargaLt = recargas.reduce((s, r) => s + (r.litros || 0), 0);

  // Míter (contador acumulado de litros que SALEN de la cisterna, no-COPEC).
  // Mismo criterio que el míter del Resumen: suma TODO lo no-COPEC (propio y
  // externo); las devoluciones de empresas suben el estanque pero NO el míter.
  //   inicial = acumulado histórico + todo lo no-COPEC ANTES de este día.
  //   final   = inicial + lo no-COPEC DURANTE este día.
  const esMiter = (r) => (r.fuente || 'cisterna') !== 'copec';
  const miterInicial = ACUM_INICIAL_ENTREGADO + _records
    .filter(r => esMiter(r) && diaLocal(r.fecha) < dia)
    .reduce((s, r) => s + (r.litriosIngresados || 0), 0);
  const miterDia = cargas
    .filter(esMiter)
    .reduce((s, r) => s + (r.litriosIngresados || 0), 0);
  const miterFinal = miterInicial + miterDia;

  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setTxt('dkTotalDia', fmt(totalDia) + ' Lt');
  setTxt('dkCargasDia', cargas.length);
  setTxt('dkBesalcoDia', fmt(besalco) + ' Lt');
  setTxt('dkExternosDia', fmt(externos) + ' Lt');
  setTxt('dkRecargaDia', recargaLt > 0 ? '+' + fmt(recargaLt) + ' Lt' : '—');
  setTxt('dkMiterIniDia', fmt(miterInicial) + ' Lt');
  setTxt('dkMiterFinDia', fmt(miterFinal) + ' Lt');

  // Tabla detalle.
  if (!cargas.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="td-loading">Sin cargas registradas este día</td></tr>';
    return;
  }
  const hora = (iso) => new Date(iso).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
  const destino = (r) => r.esExterno
    ? `${r.empresaExterna || 'Externo'}${r.conductorExterno ? ' · ' + r.conductorExterno : ''}`
    : (r.equipoNombre || equipoNombre(r.equipoId));
  // Origen del consumo: externo (MLP, etc.) o Besalco (todo lo no-externo).
  const fuenteBadge = (r) => r.esExterno
    ? '<span class="pct-warn" style="padding:2px 8px;border-radius:6px;font-size:11px">Externos</span>'
    : '<span class="pct-ok" style="padding:2px 8px;border-radius:6px;font-size:11px">Besalco</span>';

  tbody.innerHTML = cargas.map(r => `
    <tr>
      <td>${hora(r.fecha)}</td>
      <td>${destino(r)}</td>
      <td>${r.equipoPatente || '—'}</td>
      <td><strong>${fmt(r.litriosIngresados, 0)} Lt</strong></td>
      <td>${fuenteBadge(r)}</td>
      <td>${r.operador || '—'}</td>
    </tr>`).join('');
}

// ---- Modo oscuro ----
// Ajusta los colores por defecto de Chart.js según el tema, para que ejes,
// grillas y leyendas se vean en ambos modos (los datasets ya traen su color).
function aplicarTemaCharts() {
  if (typeof Chart === 'undefined') return;
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  Chart.defaults.color = dark ? '#A7B0BE' : '#5B6472';
  Chart.defaults.borderColor = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
}

// Redibuja todos los charts (para que tomen los nuevos colores de tema).
function redibujarCharts() {
  aplicarTemaCharts();
  if (!_equipos.length && !_records.length) return; // aún sin datos
  renderAll();
}

function toggleTheme() {
  const root = document.documentElement;
  const dark = root.getAttribute('data-theme') === 'dark';
  if (dark) {
    root.removeAttribute('data-theme');
    localStorage.setItem('dashTheme', 'light');
  } else {
    root.setAttribute('data-theme', 'dark');
    localStorage.setItem('dashTheme', 'dark');
  }
  redibujarCharts();
}

// Aplica el tema guardado al cargar la página.
(function aplicarTemaGuardado() {
  if (localStorage.getItem('dashTheme') === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
  aplicarTemaCharts();
})();

// ---- Equipos section ----
function filterEquipos(btn) {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _equipoFilter = btn.dataset.filter;
  renderEquipos();
}

function filterEquiposText() { renderEquipos(); }

function sortEquipos(sel) {
  _equipoSort = sel.value;
  renderEquipos();
}

// Ordena la lista de equipos según el criterio elegido. Los equipos sin % de
// uso (sin medidor configurado) se mandan al final en los órdenes por uso.
function ordenarEquipos(lista) {
  const arr = [...lista];
  const pct = (e) => { const p = getPct(e); return p == null ? -1 : p; };
  const restante = (e) => {
    const m = getMedidorCritico(e);
    return (m && m.restante != null) ? m.restante : Infinity;
  };
  switch (_equipoSort) {
    case 'uso_asc':
      // Menor % primero, pero los "sin dato" (−1) al final.
      arr.sort((a, b) => {
        const pa = pct(a), pb = pct(b);
        if (pa < 0 && pb < 0) return 0;
        if (pa < 0) return 1;
        if (pb < 0) return -1;
        return pa - pb;
      });
      break;
    case 'nombre':
      arr.sort((a, b) => (a.nombre || '').toLowerCase().localeCompare((b.nombre || '').toLowerCase()));
      break;
    case 'restante_asc':
      arr.sort((a, b) => restante(a) - restante(b));
      break;
    case 'uso_desc':
    default:
      arr.sort((a, b) => pct(b) - pct(a)); // mayor % primero
      break;
  }
  return arr;
}

// Nombres de grupos existentes (equipos con grupo asignado), ordenados.
function gruposEquipos() {
  const set = new Set();
  _equipos.forEach(e => { if (e.grupo && e.grupo.trim()) set.add(e.grupo.trim()); });
  return [...set].sort((a, b) => a.localeCompare(b, 'es'));
}

// Llena el <select> de grupos (solo si hay grupos creados).
function poblarSelectGrupos() {
  const sel = document.getElementById('selectGrupo');
  if (!sel) return;
  const grupos = gruposEquipos();
  sel.style.display = grupos.length ? '' : 'none';
  const actual = _grupoFilter;
  sel.innerHTML = '<option value="todos">Todos los grupos</option>' +
    grupos.map(g => `<option value="${g}">${g}</option>`).join('');
  // Conserva la selección si sigue existiendo.
  sel.value = grupos.includes(actual) ? actual : 'todos';
  if (sel.value !== actual) _grupoFilter = sel.value;
}

function filterEquiposGrupo(sel) {
  _grupoFilter = sel.value;
  renderEquipos();
}

// Equipos según los filtros activos en pantalla (estado, grupo, búsqueda).
// Reutilizado por la grilla y por la exportación del reporte de uso.
function equiposFiltrados() {
  const q = (document.getElementById('searchEquipos')?.value || '').toLowerCase();
  let lista = [..._equipos];
  if (_equipoFilter === '__doc') {
    lista = lista.filter(e => tieneDocVencido(e));
  } else if (_equipoFilter === '__venc') {
    lista = lista.filter(e => { const p = getPctAlerta(e); return p != null && p >= 100; });
  } else if (_equipoFilter === '__bidon') {
    lista = lista.filter(e => esBidon(e));
  } else if (_equipoFilter !== 'todos') {
    lista = lista.filter(e => e.estado === _equipoFilter);
  }
  if (_grupoFilter !== 'todos') lista = lista.filter(e => (e.grupo || '').trim() === _grupoFilter);
  if (q) {
    lista = lista.filter(e =>
      (e.nombre  || '').toLowerCase().includes(q) ||
      (e.patente || '').toLowerCase().includes(q) ||
      (e.codigo  || '').toLowerCase().includes(q)
    );
  }
  return lista;
}

// ════════════════════════════════════════════════════════════════════════
// EXPORTAR REPORTE DE USO DE EQUIPOS (Excel / PDF)
// Para cada equipo filtrado y un período [desde, hasta]: horómetro/km inicial
// y final (con sus fechas reales), avance, combustible del período y la
// relación km|h por litro.
// ════════════════════════════════════════════════════════════════════════

// Calcula la fila de uso de un equipo en el período dado.
function _filaUsoEquipo(e, desde, hasta) {
  const unidad = (e.unidadMantencion === 'horas' || (e.horasActual != null && e.kmActual == null)) ? 'h' : 'km';

  // Cargas del equipo dentro del rango, con lectura de medidor, cronológico.
  const cargas = _records
    .filter(r => r.equipoId === e.id && !r.esExterno)
    .filter(r => { const t = new Date(r.fecha); return t >= desde && t <= hasta; })
    .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));

  const conLectura = cargas.filter(r => r.kmOHoras != null);
  const combustible = cargas.reduce((s, r) => s + (r.litriosIngresados || 0), 0);

  let iniVal = null, iniFecha = null, finVal = null, finFecha = null;
  if (conLectura.length) {
    iniVal = conLectura[0].kmOHoras;         iniFecha = new Date(conLectura[0].fecha);
    finVal = conLectura[conLectura.length - 1].kmOHoras; finFecha = new Date(conLectura[conLectura.length - 1].fecha);
  }
  const avance = (iniVal != null && finVal != null) ? Math.max(0, finVal - iniVal) : null;

  // Estimación a los bordes del rango, extrapolando por la tasa de avance.
  let iniEst = null, finEst = null;
  if (iniVal != null && finVal != null && iniFecha && finFecha && finFecha > iniFecha && avance > 0) {
    const dias = (finFecha - iniFecha) / 86400000;
    const tasa = avance / dias; // unidad por día
    iniEst = iniVal - tasa * ((iniFecha - desde) / 86400000);
    finEst = finVal + tasa * ((hasta - finFecha) / 86400000);
  }

  // Relación medidor/litro (cuánto avanzó por cada litro consumido).
  const relacion = (avance != null && combustible > 0) ? (avance / combustible) : null;

  return { e, unidad, cargas: cargas.length, combustible, iniVal, iniFecha, finVal, finFecha, avance, iniEst, finEst, relacion };
}

function _fmtFecha(d) {
  return d ? d.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
}

function exportarUsoEquipos(formato) {
  const dDesde = document.getElementById('expDesde').value;
  const dHasta = document.getElementById('expHasta').value;
  if (!dDesde || !dHasta) {
    alert('Selecciona el rango de fechas (Desde y Hasta) para el reporte.');
    return;
  }
  const desde = new Date(dDesde + 'T00:00:00');
  const hasta = new Date(dHasta + 'T23:59:59');
  if (hasta < desde) { alert('La fecha "Hasta" debe ser posterior a "Desde".'); return; }

  const equipos = ordenarEquipos(equiposFiltrados());
  if (!equipos.length) { alert('No hay equipos en el filtro actual.'); return; }

  const filas = equipos.map(e => _filaUsoEquipo(e, desde, hasta));
  const periodo = `${_fmtFecha(desde)} a ${_fmtFecha(hasta)}`;

  if (formato === 'excel') _exportarExcel(filas, periodo);
  else _exportarPDF(filas, periodo);
}

// Valor con su unidad real pegada, ej: "5.000 km" / "1.240 h".
function _conUnidad(val, unidad) {
  return val != null ? `${Math.round(val)} ${unidad}` : '—';
}

function _exportarExcel(filas, periodo) {
  if (typeof XLSX === 'undefined') { alert('No se pudo cargar la librería de Excel.'); return; }
  const wb = XLSX.utils.book_new();

  // ── Hoja 1: USO REAL (con unidades reales por equipo) ──
  const cab = [
    'Equipo', 'Patente', 'Grupo',
    'Medidor inicial', 'Fecha inicial', 'Medidor final', 'Fecha final',
    'Avance', 'Combustible (Lt)', 'Nº cargas', 'Rendimiento (avance/Lt)'
  ];
  const datos = filas.map(f => [
    f.e.nombre, f.e.patente, (f.e.grupo || '').trim() || '—',
    _conUnidad(f.iniVal, f.unidad), _fmtFecha(f.iniFecha),
    _conUnidad(f.finVal, f.unidad), _fmtFecha(f.finFecha),
    _conUnidad(f.avance, f.unidad),
    Math.round(f.combustible), f.cargas,
    f.relacion != null ? `${f.relacion.toFixed(2)} ${f.unidad}/Lt` : '—'
  ]);
  const ws1 = XLSX.utils.aoa_to_sheet([
    ['Reporte de uso de equipos — DATOS REALES'], ['Período: ' + periodo], [], cab, ...datos
  ]);
  ws1['!cols'] = cab.map(() => ({ wch: 16 }));
  XLSX.utils.book_append_sheet(wb, ws1, 'Uso real');

  // ── Hoja 2: ESTIMADO A LOS BORDES DEL PERÍODO ──
  const cabEst = [
    'Equipo', 'Patente', 'Estimado inicio período', 'Estimado fin período', 'Avance estimado'
  ];
  const datosEst = filas.map(f => {
    const avEst = (f.iniEst != null && f.finEst != null) ? f.finEst - f.iniEst : null;
    return [
      f.e.nombre, f.e.patente,
      _conUnidad(f.iniEst, f.unidad), _conUnidad(f.finEst, f.unidad), _conUnidad(avEst, f.unidad)
    ];
  });
  const ws2 = XLSX.utils.aoa_to_sheet([
    ['Reporte de uso de equipos — ESTIMADO (extrapolado a los bordes del período)'],
    ['Período: ' + periodo], ['Nota: valores estimados según la tasa de avance, no medidos.'], [],
    cabEst, ...datosEst
  ]);
  ws2['!cols'] = cabEst.map(() => ({ wch: 20 }));
  XLSX.utils.book_append_sheet(wb, ws2, 'Estimado');

  XLSX.writeFile(wb, `uso_equipos_${_slugFecha()}.xlsx`);
}

function _exportarPDF(filas, periodo) {
  if (!window.jspdf || !window.jspdf.jsPDF) { alert('No se pudo cargar la librería de PDF.'); return; }
  const doc = new window.jspdf.jsPDF({ orientation: 'landscape' });
  doc.setFontSize(14);
  doc.text('Reporte de uso de equipos', 14, 15);
  doc.setFontSize(10);
  doc.text('Período: ' + periodo, 14, 22);

  // ── Tabla 1: datos reales (unidad pegada a cada valor) ──
  const head = [[
    'Equipo', 'Patente', 'Medidor ini', 'Fecha ini', 'Medidor fin', 'Fecha fin',
    'Avance', 'Comb. (Lt)', 'Cargas', 'Rendimiento'
  ]];
  const body = filas.map(f => [
    f.e.nombre, f.e.patente,
    _conUnidad(f.iniVal, f.unidad), _fmtFecha(f.iniFecha),
    _conUnidad(f.finVal, f.unidad), _fmtFecha(f.finFecha),
    _conUnidad(f.avance, f.unidad),
    fmt(Math.round(f.combustible)), f.cargas,
    f.relacion != null ? `${f.relacion.toFixed(2)} ${f.unidad}/Lt` : '—'
  ]);
  doc.autoTable({
    head, body, startY: 27, styles: { fontSize: 7, cellPadding: 1.5 },
    headStyles: { fillColor: [0, 70, 168] },
    alternateRowStyles: { fillColor: [240, 244, 250] },
  });

  // ── Tabla 2: estimado a los bordes del período (en página aparte) ──
  doc.addPage();
  doc.setFontSize(13);
  doc.text('Estimado a los bordes del período', 14, 15);
  doc.setFontSize(9);
  doc.text('Valores extrapolados por la tasa de avance (no medidos). Período: ' + periodo, 14, 21);

  const headEst = [['Equipo', 'Patente', 'Estimado inicio', 'Estimado fin', 'Avance estimado']];
  const bodyEst = filas.map(f => {
    const avEst = (f.iniEst != null && f.finEst != null) ? f.finEst - f.iniEst : null;
    return [
      f.e.nombre, f.e.patente,
      _conUnidad(f.iniEst, f.unidad), _conUnidad(f.finEst, f.unidad), _conUnidad(avEst, f.unidad)
    ];
  });
  doc.autoTable({
    head: headEst, body: bodyEst, startY: 26, styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [150, 120, 40] },
    alternateRowStyles: { fillColor: [248, 244, 235] },
  });

  doc.save(`uso_equipos_${_slugFecha()}.pdf`);
}

function _slugFecha() {
  return new Date().toISOString().slice(0, 10);
}

// Abre directamente el calendario nativo al tocar un input de fecha (sin que
// se pueda escribir). showPicker() está soportado en navegadores modernos.
function abrirCalendario(input) {
  if (input && typeof input.showPicker === 'function') {
    try { input.showPicker(); } catch (_) { /* algunos navegadores lo bloquean si no es gesto directo */ }
  }
}

function renderEquipos() {
  poblarSelectGrupos();
  const grid = document.getElementById('equiposGrid');

  let lista = equiposFiltrados();

  if (!lista.length) {
    grid.innerHTML = '<p class="loading-text">No hay equipos con ese filtro.</p>';
    return;
  }

  lista = ordenarEquipos(lista);

  grid.innerHTML = lista.map(e => {
    const estadoCls = e.estado === 'mantencion' ? 'badge-mant' :
                      e.estado === 'fuera_servicio' ? 'badge-fuera' :
                      e.estado === 'baja' ? 'badge-baja' : 'badge-activo';
    const estadoText = e.estado === 'mantencion' ? 'En Mantención' :
                       e.estado === 'fuera_servicio' ? 'Fuera de Servicio' :
                       e.estado === 'baja' ? 'Dado de Baja' : 'Activo';
    const cardCls = e.estado === 'mantencion' ? 'mantencion' :
                    e.estado === 'fuera_servicio' ? 'fuera_servicio' :
                    e.estado === 'baja' ? 'baja' : '';

    // Los bidones no llevan medidores: se muestran con una nota propia.
    const medidores = medidoresDe(e);
    const bloques = esBidon(e)
      ? `<div class="equipo-medidor equipo-bidon-nota">
           <span class="bidon-icon">🛢️</span> Bidón de reserva · sin mantención
         </div>`
      : medidores.map(m => {
      if (m.pct == null) {
        return `<div class="equipo-medidor">
                  <div class="equipo-progress-label"><span>${m.label}</span><span>—</span></div>
                  <div class="med-detail">Actual: ${m.actual != null ? fmt(m.actual) + ' ' + m.unidad : '—'} · Próx: ${m.proximo != null ? fmt(m.proximo) + ' ' + m.unidad : '—'}</div>
                </div>`;
      }
      const pctCls = m.pct >= 100 ? 'danger' : m.pct >= 80 ? 'warn' : '';
      return `
        <div class="equipo-medidor">
          <div class="equipo-progress-label">
            <span>${m.label}</span><span>${m.pct.toFixed(0)}%</span>
          </div>
          <div class="equipo-progress-bar">
            <div class="equipo-progress-fill ${pctCls}" style="width:${Math.min(m.pct, 100).toFixed(1)}%"></div>
          </div>
          <div class="med-detail">
            Actual: ${fmt(m.actual)} ${m.unidad} · Próx: ${fmt(m.proximo)} ${m.unidad}
            ${m.restante != null ? ' · Faltan ' + fmt(m.restante) + ' ' + m.unidad : ''}
          </div>
        </div>`;
    }).join('');

    return `
      <div class="equipo-card ${cardCls} equipo-clickable" onclick="abrirModalEquipo('${encodeURIComponent(e.id)}')" title="Ver detalle del equipo">
        <div class="equipo-header">
          <div>
            <div class="equipo-nombre">${esBidon(e) ? '🛢️ ' : ''}${e.nombre}${esBidon(e) ? ' <span class="bidon-tag">BIDÓN</span>' : ''}</div>
            <div class="equipo-codigo">${e.patente || (esBidon(e) ? 'Sin patente' : '')}${tienePluma(e) ? ' · <span class="pluma-tag">PLUMA</span>' : ''}</div>
          </div>
          <span class="estado-badge ${estadoCls}">${estadoText}</span>
        </div>
        <div class="equipo-info">
          <span>Tipo: ${tipoLegible(e.tipo)}</span>
          ${(e.grupo && e.grupo.trim()) ? `<span>Grupo: ${e.grupo.trim()}</span>` : ''}
          ${(e.marca || e.modelo) ? `<span>Marca/Modelo: ${e.marca || ''} ${e.modelo || ''}</span>` : ''}
          ${(e.estado === 'baja' && e.fechaBaja) ? `<span>Baja: ${fmtDate(e.fechaBaja)}</span>` : ''}
        </div>
        ${bloques}
        <div class="equipo-ver-mas">Ver detalle →</div>
      </div>`;
  }).join('');
}

// ---- Chart: Combustible por Grupo / Flota ----
// "Externos" = solo entregas a terceros (esExterno). Equipos propios sin grupo
// van a "Sin grupo", y los bidones a "Bidones".
function renderChartGrupos() {
  const row = document.getElementById('rowGrupos');
  const ctx = document.getElementById('chartGrupos');
  if (!ctx) return;

  const grupos = gruposEquipos();
  if (!grupos.length) {              // sin grupos creados: oculta la fila
    if (row) row.style.display = 'none';
    if (chartGrupos) { chartGrupos.destroy(); chartGrupos = null; }
    return;
  }
  if (row) row.style.display = '';

  const grupoDe = {};
  _equipos.forEach(e => {
    // Los bidones tienen su propia categoría; el resto usa su grupo (o 'Sin grupo').
    grupoDe[e.id] = esBidon(e)
      ? 'Bidones'
      : (e.grupo && e.grupo.trim()) ? e.grupo.trim() : 'Sin grupo';
  });

  const porGrupo = {};
  _records.forEach(r => {
    // "Externos" contiene SOLO entregas a terceros. Los equipos propios van a
    // su grupo (o 'Sin grupo'); cargas de equipos ya borrados, también.
    if (r.esExterno) {
      porGrupo['Externos'] = (porGrupo['Externos'] || 0) + (r.litriosIngresados || 0);
      return;
    }
    const g = grupoDe[r.equipoId] || 'Sin grupo';
    porGrupo[g] = (porGrupo[g] || 0) + (r.litriosIngresados || 0);
  });

  const entradas = Object.entries(porGrupo).sort((a, b) => b[1] - a[1]);
  const paleta = ['#003478', '#F39C12', '#27AE60', '#8E44AD', '#16A085', '#E74C3C', '#95A5A6'];
  const nombresGrupos = entradas.map(e => e[0]); // orden mostrado en el eje

  // Altura acorde al nº de grupos para que ninguna barra quede aplastada.
  const bodyG = ctx.closest('.chart-body');
  if (bodyG) bodyG.style.height = Math.max(260, entradas.length * 32 + 40) + 'px';

  if (chartGrupos) chartGrupos.destroy();
  chartGrupos = new Chart(ctx.getContext('2d'), {
    type: 'bar',
    data: {
      labels: nombresGrupos,
      datasets: [{ label: 'Litros', data: entradas.map(e => Math.round(e[1])),
        backgroundColor: entradas.map((_, i) => paleta[i % paleta.length]),
        borderRadius: 6, borderSkipped: false }],
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      // Al pinchar una barra, muestra el desglose de equipos de ese grupo.
      onClick: (evt, elements) => {
        if (!elements.length) return;
        const grupo = nombresGrupos[elements[0].index];
        renderChartSubgrupo(grupo, grupoDe);
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => `${fmt(c.parsed.x)} Lt · click para ver equipos` } },
      },
      scales: {
        x: { beginAtZero: true, grid: { color: '#F0F0F0' }, ticks: { callback: v => fmt(v) + ' Lt' } },
        y: { grid: { display: false } },
      },
    },
  });

  // Muestra el desglose del grupo previamente seleccionado, o el 1º por defecto.
  const inicial = (_grupoSeleccionadoSub && nombresGrupos.includes(_grupoSeleccionadoSub))
    ? _grupoSeleccionadoSub
    : nombresGrupos[0];
  if (inicial) renderChartSubgrupo(inicial, grupoDe);
}

// ---- Chart: subdistribución — equipos dentro de un grupo ----
// [grupo] = nombre del grupo pinchado; [grupoDe] = mapa equipoId → grupo.
function renderChartSubgrupo(grupo, grupoDe) {
  _grupoSeleccionadoSub = grupo;
  const ctx = document.getElementById('chartSubgrupo');
  if (!ctx) return;
  if (chartSubgrupo) { chartSubgrupo.destroy(); chartSubgrupo = null; }

  const nom = document.getElementById('grupoSelNombre');
  const hint = document.getElementById('grupoSelHint');
  if (nom) nom.textContent = `· ${grupo}`;

  // Suma litros por equipo dentro del grupo (los externos no tienen equipo).
  const porEquipo = {}; // equipoId → litros
  _records.forEach(r => {
    const g = r.esExterno ? 'Externos' : (grupoDe[r.equipoId] || 'Sin grupo');
    if (g !== grupo) return;
    if (r.esExterno) {
      const emp = r.empresaExterna || 'Externo';
      porEquipo['ext:' + emp] = (porEquipo['ext:' + emp] || 0) + (r.litriosIngresados || 0);
    } else {
      porEquipo[r.equipoId] = (porEquipo[r.equipoId] || 0) + (r.litriosIngresados || 0);
    }
  });

  const nombreDe = (key) => {
    if (key.startsWith('ext:')) return key.slice(4);
    const e = _equipos.find(x => x.id === key);
    return e ? `${e.nombre} (${e.patente})` : key;
  };

  const entradas = Object.entries(porEquipo).sort((a, b) => b[1] - a[1]);
  if (hint) hint.textContent = entradas.length
    ? `${entradas.length} equipo(s) · pincha otro grupo para cambiar`
    : 'Sin consumo registrado en este grupo';

  if (!entradas.length) {
    // Nada que graficar.
    return;
  }

  // La altura del gráfico crece con el nº de barras (≈32px por equipo), para que
  // NINGÚN equipo quede aplastado ni oculto cuando el grupo tiene muchos.
  const alto = Math.max(260, entradas.length * 32 + 40);
  const body = ctx.closest('.chart-body');
  if (body) body.style.height = alto + 'px';

  const paleta = ['#1F6FEB', '#F39C12', '#27AE60', '#8E44AD', '#16A085', '#E74C3C', '#E67E22', '#2E86C1', '#95A5A6'];

  chartSubgrupo = new Chart(ctx.getContext('2d'), {
    type: 'bar',
    data: {
      labels: entradas.map(e => nombreDe(e[0])),
      datasets: [{ label: 'Litros', data: entradas.map(e => Math.round(e[1])),
        backgroundColor: entradas.map((_, i) => paleta[i % paleta.length]),
        borderRadius: 6, borderSkipped: false }],
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => `${fmt(c.parsed.x)} Lt` } },
      },
      scales: {
        x: { beginAtZero: true, grid: { color: '#F0F0F0' }, ticks: { callback: v => fmt(v) + ' Lt' } },
        y: { grid: { display: false } },
      },
    },
  });
}

// ---- Mantencion section ----
function renderMantencionSection() {
  renderChartMantencion();
  renderChartUsoMantencion();
  renderTableMantencion();
  renderHistorialMantencion();
}

// Historial real de mantenciones realizadas (maintenance_records).
function renderHistorialMantencion() {
  const tbody = document.getElementById('tbodyHistMant');
  if (!tbody) return;
  if (!_maintenance.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="td-loading">Sin mantenciones registradas</td></tr>';
    return;
  }

  const tipoBadge = (t) => {
    const cls = t === 'correctiva' ? 'pct-danger'
              : t === 'preventiva' ? 'src-cist' : 'src-ext';
    const tag = cls === 'src-cist' ? 'src-badge src-cist'
              : cls === 'src-ext' ? 'src-badge src-ext' : 'pct-badge pct-danger';
    return `<span class="${tag}">${(t || '—').toUpperCase()}</span>`;
  };

  tbody.innerHTML = _maintenance.slice(0, 100).map(m => {
    const eq = _equipos.find(e => e.id === m.equipoId);
    return `
      <tr>
        <td>${fmtDate(m.fechaMantencion)}</td>
        <td><strong>${eq ? eq.nombre : (m.equipoId || '—')}</strong>${eq ? ` <small style="color:#888">${eq.patente}</small>` : ''}</td>
        <td>${tipoBadge(m.tipo)}</td>
        <td style="max-width:240px">${m.descripcion || '—'}</td>
        <td>${m.responsable || '—'}</td>
        <td><strong>${(m.costo || 0) > 0 ? '$' + fmt(m.costo) : '—'}</strong></td>
      </tr>`;
  }).join('');
}

function renderChartMantencion() {
  // Excluye dados de baja de las alertas de mantención.
  const flota    = _equipos.filter(e => e.estado !== 'baja');
  const ok       = flota.filter(e => { const p = getPct(e); return p == null || p < 80; }).length;
  const proximos = flota.filter(e => { const p = getPct(e); return p != null && p >= 80 && p < 100; }).length;
  const urgentes = flota.filter(e => { const p = getPct(e); return p != null && p >= 100; }).length;

  const ctx = document.getElementById('chartMantencion').getContext('2d');
  if (chartMant) chartMant.destroy();
  chartMant = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Al día', 'Próximos (80–99%)', 'Urgentes (≥100%)'],
      datasets: [{ data: [ok, proximos, urgentes],
        backgroundColor: ['#27AE60', '#F39C12', '#E74C3C'], borderWidth: 0, hoverOffset: 6 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '60%',
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, padding: 14, font: { size: 12 } } } },
    },
  });
}

function renderChartUsoMantencion() {
  // Una barra por medidor crítico de cada equipo (incluye pluma). Sin baja.
  const data = _equipos
    .filter(e => e.estado !== 'baja')
    .map(e => {
      const m = getMedidorCritico(e);
      return m ? { nombre: `${e.nombre} (${e.patente})${m.tipo === 'pluma' ? ' [Pluma]' : ''}`, pct: m.pct } : null;
    })
    .filter(x => x && x.pct > 0)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 10);

  const ctx = document.getElementById('chartUsoMantencion').getContext('2d');
  if (chartUsoMant) chartUsoMant.destroy();
  chartUsoMant = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.map(d => d.nombre),
      datasets: [{ label: '% uso', data: data.map(d => Math.min(d.pct, 120)),
        backgroundColor: data.map(d => d.pct >= 100 ? '#E74C3C' : d.pct >= 80 ? '#F39C12' : '#27AE60'),
        borderRadius: 6, borderSkipped: false }],
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { min: 0, max: 120, grid: { color: '#F0F0F0' }, ticks: { callback: v => v + '%' } },
        y: { grid: { display: false } },
      },
    },
  });
}

function renderTableMantencion() {
  // Cada fila = un medidor en alerta (un equipo pluma puede aparecer 2 veces).
  // Los equipos dados de baja no generan alertas de mantención.
  const filas = [];
  _equipos.filter(e => e.estado !== 'baja').forEach(e => {
    medidoresDe(e).forEach(m => {
      if (m.pct != null && m.pct >= 80) filas.push({ e, m });
    });
  });
  filas.sort((a, b) => b.m.pct - a.m.pct);

  const tbody = document.getElementById('tbodyMantencion');
  if (!filas.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="td-loading">Sin equipos con alertas de mantenimiento</td></tr>';
    return;
  }

  tbody.innerHTML = filas.map(({ e, m }) => {
    const pctCls = m.pct >= 100 ? 'pct-danger' : 'pct-warn';
    const estadoText = m.pct >= 100 ? 'URGENTE' : 'PRÓXIMO';
    const estadoCls  = m.pct >= 100 ? 'badge-fuera' : 'badge-mant';
    const proj = getProyeccion(e);
    const projStr = proj
      ? proj.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : '—';
    const projStyle = proj && m.pct < 100
      ? (proj - new Date() < 7 * 86400000 ? 'color:#E74C3C;font-weight:600' : 'color:#F39C12;font-weight:600')
      : '';
    return `
      <tr>
        <td><strong>${e.nombre}</strong></td>
        <td>${e.patente}</td>
        <td>${m.label}</td>
        <td><span class="pct-badge ${pctCls}">${m.pct.toFixed(0)}%</span></td>
        <td>${m.restante != null ? fmt(m.restante, 0) + ' ' + m.unidad : '—'}</td>
        <td style="${projStyle}">${projStr}</td>
        <td><span class="estado-badge ${estadoCls}">${estadoText}</span></td>
      </tr>`;
  }).join('');
}

// ---- Registros section ----
let _allRecordsFiltered = [];

function renderRegistrosSection() {
  const total          = _records.length;
  const litrosCisterna = _records.filter(r => (r.fuente || 'cisterna') !== 'copec' && !r.esExterno)
                                  .reduce((s, r) => s + (r.litriosIngresados || 0), 0);
  const litrosCopec    = _records.filter(r => r.fuente === 'copec')
                                  .reduce((s, r) => s + (r.litriosIngresados || 0), 0);
  const externoEntregado = _records.filter(r => r.esExterno)
                                  .reduce((s, r) => s + (r.litriosIngresados || 0), 0);
  // Devoluciones físicas de combustible (no pagos en dinero) bajan el neto.
  const externoDevuelto = _returns.filter(d => (d.tipo || 'combustible') === 'combustible')
                                  .reduce((s, d) => s + (d.litros || 0), 0);
  const litrosExterno = Math.max(0, externoEntregado - externoDevuelto);

  document.getElementById('kpiTotalRegistros').textContent = total;
  document.getElementById('kpiLitrosCisterna').textContent = fmt(litrosCisterna, 0);
  document.getElementById('kpiLitrosCopec').textContent    = fmt(litrosCopec, 0);
  const extEl = document.getElementById('kpiLitrosExterno');
  if (extEl) extEl.textContent = fmt(litrosExterno, 0);

  _allRecordsFiltered = [..._records];
  renderTbodyAllRecords();
}

function filterAllRecords() {
  const q = document.getElementById('searchAllRecords').value.toLowerCase();
  _allRecordsFiltered = _records.filter(r =>
    (r.equipoNombre  || '').toLowerCase().includes(q) ||
    (r.operador      || '').toLowerCase().includes(q) ||
    (r.equipoPatente || '').toLowerCase().includes(q) ||
    (r.areaTrabajo   || '').toLowerCase().includes(q) ||
    (r.empresaExterna|| '').toLowerCase().includes(q) ||
    (r.notas         || '').toLowerCase().includes(q)
  );
  renderTbodyAllRecords();
}

function renderTbodyAllRecords() {
  const tbody = document.getElementById('tbodyAllRecords');
  if (!_allRecordsFiltered.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="td-loading">Sin registros</td></tr>';
    return;
  }
  tbody.innerHTML = _allRecordsFiltered.slice(0, 200).map(r => `
    <tr>
      <td>${fmtDate(r.fecha)}</td>
      <td>${r.equipoNombre || '—'}${r.esExterno ? ` <small>(${r.conductorExterno || ''})</small>` : ''}</td>
      <td>${r.equipoPatente || '—'}</td>
      <td><strong>${fmt(r.litriosIngresados, 1)} Lt</strong></td>
      <td>${medidorRegistro(r)}</td>
      <td>${areaBadge(r.areaTrabajo)}</td>
      <td>${fuenteBadge(r)}</td>
      <td>${r.operador || '—'}</td>
      <td style="max-width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${r.notas || '—'}</td>
    </tr>`).join('');
}

// ---- Documentación section ----
function renderDocumentos() {
  const tbody = document.getElementById('tbodyDocumentos');
  if (!tbody) return;
  const ahora = new Date();

  // Todos los documentos de todos los equipos, ordenados por vencimiento.
  const filas = [];
  _equipos.forEach(e => {
    const docs = e.documentos || {};
    Object.entries(docs).forEach(([nombre, info]) => {
      const esObj = info && typeof info === 'object';
      const noVence = esObj && info.noVence === true;
      const venceStr = esObj ? info.vence : info;
      const fotoUrl = esObj ? info.fotoUrl : null;
      // Documento marcado como "no vence" (N/A): siempre vigente, sin fecha.
      if (noVence) {
        filas.push({ equipo: e.nombre, patente: e.patente, nombre,
                     vence: null, dias: null, estado: 'vigente', noVence: true, fotoUrl });
        return;
      }
      if (!venceStr) return;
      const vence = new Date(venceStr);
      const dias = Math.ceil((vence - ahora) / 86400000);
      const estado = dias < 0 ? 'vencido' : (dias <= 14 ? 'porVencer' : 'vigente');
      filas.push({ equipo: e.nombre, patente: e.patente, nombre, vence, dias, estado, noVence: false, fotoUrl });
    });
  });
  // Ordena: los "no vence" al final; el resto por fecha de vencimiento.
  filas.sort((a, b) => {
    if (a.noVence !== b.noVence) return a.noVence ? 1 : -1;
    if (a.noVence) return 0;
    return a.vence - b.vence;
  });

  // KPIs de la sección.
  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setTxt('kpiDocVencidos', filas.filter(f => f.estado === 'vencido').length);
  setTxt('kpiDocPorVencer', filas.filter(f => f.estado === 'porVencer').length);
  setTxt('kpiDocVigentes', filas.filter(f => f.estado === 'vigente').length);

  if (!filas.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="td-loading">Sin documentación registrada</td></tr>';
    return;
  }

  const badge = (f) => {
    if (f.noVence) return '<span class="src-badge src-cist">NO VENCE</span>';
    if (f.estado === 'vencido') return '<span class="pct-badge pct-danger">VENCIDO</span>';
    if (f.estado === 'porVencer') return '<span class="pct-badge pct-warn">POR VENCER</span>';
    return '<span class="src-badge src-cist">VIGENTE</span>';
  };

  tbody.innerHTML = filas.map(f => `
    <tr>
      <td><strong>${f.equipo}</strong></td>
      <td>${f.patente}</td>
      <td>${f.nombre}</td>
      <td>${f.noVence
            ? '<span style="color:#888">No vence (N/A)</span>'
            : `${f.vence.toLocaleDateString('es-CL')}${f.estado !== 'vencido' ? ` <small style="color:#888">(${f.dias}d)</small>` : ''}`}</td>
      <td>${badge(f)}${f.fotoUrl ? ` <a href="${f.fotoUrl}" target="_blank" style="margin-left:6px">📎</a>` : ''}</td>
    </tr>`).join('');
}

// ---- Cuentas Externos section ----
function renderExternos() {
  const tbody = document.getElementById('tbodyExternos');
  if (!tbody) return;
  const cuentas = cuentasExternos();

  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  // Solo cuentan como deuda las empresas que SÍ se cobran (no incluidas).
  const conDeuda = cuentas.filter(c => c.saldo > 0 && !c.incluida);
  const deudaTotal = conDeuda.reduce((s, c) => s + c.saldo, 0);
  setTxt('kpiDeudaLitros', fmt(deudaTotal) + ' Lt');
  setTxt('kpiDeudaMonto', _precioLitro > 0 ? '$' + fmt(deudaTotal * _precioLitro) : '—');
  setTxt('kpiEmpresasDeuda', conDeuda.length);

  if (!cuentas.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="td-loading">Sin entregas a externos</td></tr>';
    return;
  }

  tbody.innerHTML = cuentas.map(c => {
    const saldado = c.saldo <= 0;
    const badge = c.incluida
      ? '<span class="src-badge src-ext">INCLUIDO</span>'
      : (saldado
          ? '<span class="src-badge src-cist">AL DÍA</span>'
          : '<span class="pct-badge pct-danger">DEBE</span>');
    // En incluidas no se muestra valor $ (no se cobran).
    const saldoCol = c.incluida
      ? `<strong>${fmt(c.saldo < 0 ? 0 : c.saldo)} Lt</strong> <small style="color:#888">(no se cobra)</small>`
      : `<strong>${fmt(c.saldo < 0 ? 0 : c.saldo)} Lt</strong>${_precioLitro > 0 ? ` <small style="color:#888">($${fmt((c.saldo < 0 ? 0 : c.saldo) * _precioLitro)})</small>` : ''}`;
    return `
      <tr>
        <td><strong>${c.empresa}</strong></td>
        <td>${fmt(c.entregado)} Lt</td>
        <td>${fmt(c.devuelto)} Lt</td>
        <td>${saldoCol}</td>
        <td>${badge}</td>
      </tr>`;
  }).join('');
}

// ---- Reportes Diarios de Operación ----

// Horas trabajadas de un reporte = (fin - inicio)/60 - colación (mín 0).
function horasTrabajadasReporte(r) {
  const jornada = ((r.finMinutos || 0) - (r.inicioMinutos || 0)) / 60;
  const t = jornada - (r.colacionHoras != null ? r.colacionHoras : 1);
  return t < 0 ? 0 : t;
}

// ID reservado para las horas de máquina del horómetro de la jornada. Como en
// la app, cuenta como uso efectivo por defecto aunque no esté en config/factores.
const TAREA_HOROMETRO = 'operacion_horometro';

// Clasificación de una tarea. Espeja FactoresConfig.clasificacionDe de la app:
// el horómetro es uso efectivo si no hay una clasificación explícita.
function clasificacionDe(tareaId) {
  const c = _factoresConfig[tareaId];
  if (c) return c;
  if (tareaId === TAREA_HOROMETRO) return { usoEfectivo: true };
  return {};
}

// Factores (usadas / operativas / total) de una lista de reportes, según la
// clasificación de tareas configurada. Espeja FactoresResultado.desde.
function factoresDeReportes(reportes) {
  let usadas = 0, noOp = 0, total = 0;
  reportes.forEach(r => {
    const desglose = r.desglose || {};
    Object.entries(desglose).forEach(([tareaId, horas]) => {
      const h = Number(horas) || 0;
      const c = clasificacionDe(tareaId);
      total += h;
      if (c.noOperativa) noOp += h;
      if (c.usoEfectivo) usadas += h;
    });
  });
  const operativas = total - noOp;
  return {
    usadas, operativas, total,
    fu: operativas > 0 ? usadas / operativas : 0,
    fo: total > 0 ? operativas / total : 0,
    hayDatos: total > 0,
  };
}

let _operacionQuery = '';
function filterOperacion() {
  _operacionQuery = (document.getElementById('searchOperacion')?.value || '').toLowerCase();
  renderOperacion();
}

function renderOperacion() {
  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

  // KPIs globales (todos los reportes).
  const totalHoras = _dailyReports.reduce((s, r) => s + horasTrabajadasReporte(r), 0);
  const fGlobal = factoresDeReportes(_dailyReports);
  setTxt('kpiOpReportes', _dailyReports.length);
  setTxt('kpiOpHoras', fmt(totalHoras, 1));
  setTxt('kpiOpFU', fGlobal.hayDatos ? (fGlobal.fu * 100).toFixed(1) + '%' : '—');
  setTxt('kpiOpFO', fGlobal.hayDatos ? (fGlobal.fo * 100).toFixed(1) + '%' : '—');

  // Agrupar por equipo.
  const porEquipo = {};
  _dailyReports.forEach(r => {
    (porEquipo[r.equipoId] ??= []).push(r);
  });

  let filas = Object.entries(porEquipo).map(([equipoId, reportes]) => {
    const eq = _equipos.find(x => x.id === equipoId);
    const nombre = eq ? eq.nombre : (reportes[0].equipoNombre || equipoId);
    const patente = eq ? eq.patente : (reportes[0].equipoPatente || '—');
    const horas = reportes.reduce((s, r) => s + horasTrabajadasReporte(r), 0);
    const f = factoresDeReportes(reportes);
    return { equipoId, nombre, patente, n: reportes.length, horas, f };
  }).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

  if (_operacionQuery) {
    filas = filas.filter(x =>
      x.nombre.toLowerCase().includes(_operacionQuery) ||
      (x.patente || '').toLowerCase().includes(_operacionQuery));
  }

  const tbody = document.getElementById('tbodyOperacion');
  if (!tbody) return;
  if (!filas.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="td-loading">Sin reportes diarios registrados</td></tr>';
    return;
  }

  const pctBadge = (v, hay) => {
    if (!hay) return '<span class="src-badge src-cist">—</span>';
    const p = (v * 100);
    return `<span class="${p >= 80 ? 'pct-badge pct-warn' : 'src-badge src-cist'}">${p.toFixed(1)}%</span>`;
  };

  tbody.innerHTML = filas.map(x => `
    <tr class="row-click" onclick="abrirModalOperacion('${encodeURIComponent(x.equipoId)}')" title="Ver detalle">
      <td><strong>${x.nombre}</strong></td>
      <td>${x.patente}</td>
      <td>${x.n}</td>
      <td>${fmt(x.horas, 1)} h</td>
      <td>${pctBadge(x.f.fu, x.f.hayDatos)}</td>
      <td>${pctBadge(x.f.fo, x.f.hayDatos)}</td>
    </tr>`).join('');
}

// ---- Modal: detalle de reportes diarios de un equipo ----
function fmtMinHora(m) {
  m = m || 0;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

function abrirModalOperacion(equipoIdEnc) {
  const equipoId = decodeURIComponent(equipoIdEnc);
  const reportes = _dailyReports
    .filter(r => r.equipoId === equipoId)
    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
  if (!reportes.length) return;

  const eq = _equipos.find(x => x.id === equipoId);
  const nombre = eq ? eq.nombre : (reportes[0].equipoNombre || equipoId);
  const patente = eq ? eq.patente : (reportes[0].equipoPatente || '—');
  const horas = reportes.reduce((s, r) => s + horasTrabajadasReporte(r), 0);
  const f = factoresDeReportes(reportes);

  document.getElementById('modalOpTitulo').textContent = nombre;
  document.getElementById('modalOpSub').textContent =
    `${patente} · ${reportes.length} reporte(s) · ${fmt(horas, 1)} h trabajadas`;

  const factColor = (p) => p >= 0.8 ? 'var(--verde)' : p >= 0.5 ? 'var(--naranja)' : 'var(--rojo)';
  const factBox = (label, val, hay) => `
    <div class="fact-box">
      <div class="fact-label">${label}</div>
      <div class="fact-val" style="color:${hay ? factColor(val) : 'var(--text-sm)'}">
        ${hay ? (val * 100).toFixed(1) + '%' : '—'}
      </div>
      <div class="fact-bar"><div style="width:${hay ? Math.min(val * 100, 100) : 0}%;background:${factColor(val)}"></div></div>
    </div>`;

  const dias = reportes.map(r => {
    const desglose = Object.entries(r.desglose || {}).sort((a, b) => b[1] - a[1]);
    const tags = desglose.map(([id, h]) => {
      const c = clasificacionDe(id);
      const cls = c.usoEfectivo ? 'uso' : (c.noOperativa ? 'no-op' : '');
      return `<span class="op-tag ${cls}">${etiquetaTarea(id)}: ${fmt(h, 1)} h</span>`;
    }).join('');
    const fecha = new Date(r.fecha).toLocaleDateString('es-CL', { day:'2-digit', month:'2-digit', year:'numeric' });
    return `
      <div class="op-day">
        <div class="op-day-head">
          <span>${fecha}</span>
          <span class="op-day-time">${fmtMinHora(r.inicioMinutos)}–${fmtMinHora(r.finMinutos)} · ${fmt(horasTrabajadasReporte(r), 1)} h</span>
        </div>
        <div class="op-tags">${tags || '<span class="op-notas">Sin desglose</span>'}</div>
        ${r.notas ? `<div class="op-notas">📝 ${r.notas}</div>` : ''}
        ${r.operador ? `<div class="op-notas">Op: ${r.operador}</div>` : ''}
      </div>`;
  }).join('');

  document.getElementById('modalOpBody').innerHTML = `
    <div class="fact-row">
      ${factBox('Utilización (FU)', f.fu, f.hayDatos)}
      ${factBox('Operabilidad (FO)', f.fo, f.hayDatos)}
    </div>
    ${dias}`;

  document.getElementById('modalOperacion').classList.add('open');
}

function cerrarModalOperacion(e) {
  // Si se llama por click en el overlay, solo cierra si el click fue en el fondo.
  if (e && e.target && e.target.id !== 'modalOperacion' && e.type === 'click') return;
  document.getElementById('modalOperacion').classList.remove('open');
}

// Cerrar el modal con la tecla Escape.
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { cerrarModalOperacion(); cerrarModalEquipo(); }
});

// ════════════════════════════════════════════════════════════════════════
// MODAL: DETALLE COMPLETO DE UN EQUIPO
// Avance del medidor (km/horómetro) en el tiempo, cargas de combustible y
// mantenciones realizadas.
// ════════════════════════════════════════════════════════════════════════

let chartMedidorEquipo = null;

function abrirModalEquipo(equipoIdEnc) {
  const equipoId = decodeURIComponent(equipoIdEnc);
  const eq = _equipos.find(x => x.id === equipoId);
  if (!eq) return;

  // Cargas de combustible del equipo (no externas), cronológico ascendente.
  const cargas = _records
    .filter(r => r.equipoId === equipoId && !r.esExterno)
    .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));

  // Mantenciones del equipo.
  const mantenciones = _maintenance
    .filter(m => m.equipoId === equipoId)
    .sort((a, b) => new Date(b.fechaMantencion) - new Date(a.fechaMantencion));

  document.getElementById('modalEqTitulo').textContent = eq.nombre;
  const partes = [];
  if (eq.patente) partes.push(eq.patente);
  if (eq.tipo) partes.push(tipoLegible(eq.tipo));
  if (eq.grupo && eq.grupo.trim()) partes.push('Grupo: ' + eq.grupo.trim());
  if (eq.estado === 'baja' && eq.fechaBaja) partes.push('Dado de baja: ' + fmtDate(eq.fechaBaja));
  document.getElementById('modalEqSub').textContent = partes.join(' · ');

  // ── Bloques de medidor actual (km/horómetro/pluma) ──
  const medBloques = medidoresDe(eq).map(m => {
    const pctCls = m.pct == null ? '' : (m.pct >= 100 ? 'danger' : m.pct >= 80 ? 'warn' : '');
    return `
      <div class="eqd-med">
        <div class="eqd-med-top"><span>${m.label}</span><span>${m.pct != null ? m.pct.toFixed(0) + '%' : '—'}</span></div>
        <div class="equipo-progress-bar">
          <div class="equipo-progress-fill ${pctCls}" style="width:${m.pct != null ? Math.min(m.pct, 100).toFixed(1) : 0}%"></div>
        </div>
        <div class="med-detail">Actual: ${m.actual != null ? fmt(m.actual) + ' ' + m.unidad : '—'} · Próx: ${m.proximo != null ? fmt(m.proximo) + ' ' + m.unidad : '—'}${m.restante != null ? ' · Faltan ' + fmt(m.restante) + ' ' + m.unidad : ''}</div>
      </div>`;
  }).join('') || '<p class="op-notas">Sin medidores configurados.</p>';

  // ── Métricas reales de uso (todo el historial del equipo) ──
  const unidadEq = (eq.unidadMantencion === 'horas' || (eq.horasActual != null && eq.kmActual == null)) ? 'h' : 'km';
  const conLectura = cargas.filter(r => r.kmOHoras != null); // cronológico asc
  const totalLt = cargas.reduce((s, r) => s + (r.litriosIngresados || 0), 0);
  let usoIniVal = null, usoIniF = null, usoFinVal = null, usoFinF = null, usoAvance = null, usoRend = null;
  if (conLectura.length) {
    usoIniVal = conLectura[0].kmOHoras;                       usoIniF = new Date(conLectura[0].fecha);
    usoFinVal = conLectura[conLectura.length - 1].kmOHoras;   usoFinF = new Date(conLectura[conLectura.length - 1].fecha);
    if (usoIniVal != null && usoFinVal != null) usoAvance = Math.max(0, usoFinVal - usoIniVal);
    if (usoAvance != null && totalLt > 0) usoRend = usoAvance / totalLt;
  }
  const uKpi = (val, lbl) => `<div class="day-kpi"><span class="dk-val">${val}</span><span class="dk-lbl">${lbl}</span></div>`;
  const usoPanel = conLectura.length >= 2
    ? `<div class="day-kpis eqd-uso">
        ${uKpi(`${fmt(Math.round(usoIniVal))} ${unidadEq}`, `Inicial · ${_fmtFecha(usoIniF)}`)}
        ${uKpi(`${fmt(Math.round(usoFinVal))} ${unidadEq}`, `Final · ${_fmtFecha(usoFinF)}`)}
        ${uKpi(`${fmt(Math.round(usoAvance))} ${unidadEq}`, 'Avance')}
        ${uKpi(`${fmt(Math.round(totalLt))} Lt`, 'Combustible')}
        ${uKpi(usoRend != null ? `${usoRend.toFixed(2)} ${unidadEq}/Lt` : '—', 'Rendimiento')}
      </div>`
    : '';

  const cargasRows = cargas.length
    ? cargas.slice().reverse().slice(0, 100).map(r => `
        <tr>
          <td>${fmtDate(r.fecha)}</td>
          <td><strong>${fmt(r.litriosIngresados, 1)} Lt</strong></td>
          <td>${r.kmOHoras != null ? fmt(r.kmOHoras) + ' ' + (r.tipoUnidad === 'km' ? 'km' : 'h') : '—'}</td>
          <td>${areaBadge(r.areaTrabajo)}</td>
          <td>${fuenteBadge(r)}</td>
          <td>${r.operador || '—'}</td>
        </tr>`).join('')
    : '<tr><td colspan="6" class="td-loading">Sin cargas registradas</td></tr>';

  // ── Tabla de mantenciones ──
  const mantRows = mantenciones.length
    ? mantenciones.slice(0, 50).map(m => `
        <tr>
          <td>${fmtDate(m.fechaMantencion)}</td>
          <td>${(m.tipo || '—').toUpperCase()}</td>
          <td style="max-width:220px">${m.descripcion || '—'}</td>
          <td>${m.kmEnMantencion != null ? fmt(m.kmEnMantencion) + ' km' : (m.horasEnMantencion != null ? fmt(m.horasEnMantencion) + ' h' : '—')}</td>
          <td>${m.responsable || '—'}</td>
          <td>${(m.costo || 0) > 0 ? '$' + fmt(m.costo) : '—'}</td>
          <td>${m.fotoUrl ? `<a href="${m.fotoUrl}" target="_blank" rel="noopener" title="Ver imagen">📷</a>` : '—'}</td>
        </tr>`).join('')
    : '<tr><td colspan="7" class="td-loading">Sin mantenciones registradas</td></tr>';

  // Un bidón no tiene medidor ni mantenciones: se ocultan esas secciones.
  const bidon = esBidon(eq);

  document.getElementById('modalEqBody').innerHTML = `
    <div class="eqd-meds">${medBloques}</div>

    ${usoPanel ? `<h4 class="eqd-title">Uso histórico <small>(desde la 1ª carga con lectura)</small></h4>${usoPanel}` : ''}

    ${bidon ? '' : `
    <h4 class="eqd-title">Avance del medidor en el tiempo</h4>
    <div class="eqd-chart"><canvas id="chartMedidorEquipo"></canvas></div>`}

    <h4 class="eqd-title">Cargas de combustible <small>(${cargas.length} · ${fmt(totalLt, 0)} Lt)</small></h4>
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Fecha</th><th>Litros</th><th>Medidor</th><th>Área</th><th>Fuente</th><th>Operador</th></tr></thead>
        <tbody>${cargasRows}</tbody>
      </table>
    </div>

    ${bidon ? '' : `
    <h4 class="eqd-title">Mantenciones realizadas <small>(${mantenciones.length})</small></h4>
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Fecha</th><th>Tipo</th><th>Descripción</th><th>Medidor</th><th>Responsable</th><th>Costo</th><th>Foto</th></tr></thead>
        <tbody>${mantRows}</tbody>
      </table>
    </div>`}`;

  document.getElementById('modalEquipo').classList.add('open');
  // El chart solo aplica a equipos con medidor (los bidones no lo tienen).
  if (!bidon) renderChartMedidorEquipo(cargas, mantenciones);
}

// Gráfico de avance del medidor principal (km u horómetro) usando las lecturas
// de las cargas de combustible. Marca las mantenciones como líneas verticales.
function renderChartMedidorEquipo(cargas, mantenciones) {
  const ctx = document.getElementById('chartMedidorEquipo');
  if (!ctx) return;
  if (chartMedidorEquipo) { chartMedidorEquipo.destroy(); chartMedidorEquipo = null; }

  // Puntos (fecha, lectura del medidor) de cada carga que traiga lectura.
  const puntos = cargas
    .filter(r => r.kmOHoras != null)
    .map(r => ({ t: new Date(r.fecha), v: r.kmOHoras, unidad: r.tipoUnidad === 'km' ? 'km' : 'h' }));

  if (puntos.length < 2) {
    ctx.parentElement.innerHTML = '<p class="op-notas" style="padding:20px">No hay suficientes lecturas de medidor para graficar el avance.</p>';
    return;
  }

  const unidad = puntos[puntos.length - 1].unidad;
  const labels = puntos.map(p => p.t.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: '2-digit' }));
  const data = puntos.map(p => p.v);

  chartMedidorEquipo = new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: `Medidor (${unidad})`,
        data,
        borderColor: '#1F6FEB',
        backgroundColor: 'rgba(31,111,235,0.10)',
        pointBackgroundColor: '#1F6FEB',
        pointBorderColor: '#fff',
        pointBorderWidth: 1.5,
        pointRadius: 4,
        pointHoverRadius: 7,
        borderWidth: 2.5,
        fill: true,
        tension: 0.15,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => `${fmt(c.parsed.y)} ${unidad}` } },
      },
      scales: {
        y: { beginAtZero: false, grid: { color: '#F0F0F0' }, ticks: { callback: v => fmt(v) + ' ' + unidad } },
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
      },
    },
  });
}

function cerrarModalEquipo(e) {
  if (e && e.target && e.target.id !== 'modalEquipo' && e.type === 'click') return;
  document.getElementById('modalEquipo').classList.remove('open');
  if (chartMedidorEquipo) { chartMedidorEquipo.destroy(); chartMedidorEquipo = null; }
}

// ════════════════════════════════════════════════════════════════════════
// SECCIÓN FACTORES (FU / FO)
// ════════════════════════════════════════════════════════════════════════

// Color por tarea para el desglose apilado (consistente con su clasificación).
const COLOR_TAREA = {
  operacion_horometro:    '#27AE60', // operación efectiva (verde)
  disponible_con_postura: '#2E86C1',
  disponible_sin_postura: '#5DADE2',
  disponible_sin_operador:'#85C1E9',
  condicion_climatica:    '#F4D03F',
  detencion_op_mlp:       '#E67E22',
  detencion_documental:   '#AF7AC5',
  acreditacion:           '#95A5A6',
  cambio_turno:           '#48C9B0',
  panne:                  '#E74C3C', // no operativa
  mantencion:             '#7F8C8D', // no operativa
  desmovilizado:          '#34495E',
};
function colorTarea(id) { return COLOR_TAREA[id] || '#BDC3C7'; }

// Reúne, por equipo (en el período actual de la app no aplica; usamos todos
// los reportes), los factores y el desglose de horas por tarea.
function _datosFactoresPorEquipo() {
  const porEquipo = {};
  _dailyReports.forEach(r => {
    (porEquipo[r.equipoId] ??= []).push(r);
  });
  const filas = Object.entries(porEquipo).map(([equipoId, reportes]) => {
    const eq = _equipos.find(e => e.id === equipoId);
    const nombre = eq ? eq.nombre : (reportes[0].equipoNombre || equipoId);
    const patente = eq ? eq.patente : (reportes[0].equipoPatente || '');
    const f = factoresDeReportes(reportes);
    // Horas por tarea sumadas.
    const horas = {};
    reportes.forEach(rep => {
      Object.entries(rep.desglose || {}).forEach(([id, h]) => {
        horas[id] = (horas[id] || 0) + (Number(h) || 0);
      });
    });
    return { nombre, patente, f, horas, total: f.total };
  }).filter(x => x.total > 0);
  // Orden por nombre.
  filas.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  return filas;
}

function renderFactores() {
  const filas = _datosFactoresPorEquipo();
  _renderChartFUFO(filas);
  _renderChartDesglose(filas);
}

// ── Gráfico 1: FU vs FO por equipo (2 barras por equipo) ──
function _renderChartFUFO(filas) {
  const ctx = document.getElementById('chartFUFO');
  if (!ctx) return;
  // Etiqueta en 2 líneas: nombre + patente (hay nombres repetidos).
  const labels = filas.map(x => x.patente ? [x.nombre, x.patente] : x.nombre);

  if (chartFUFO) chartFUFO.destroy();
  if (!filas.length) return;

  chartFUFO = new Chart(ctx.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'FU (Utilización)', data: filas.map(x => +(x.f.fu * 100).toFixed(1)),
          backgroundColor: '#2E86C1', borderRadius: 3 },
        { label: 'FO (Operatividad)', data: filas.map(x => +(x.f.fo * 100).toFixed(1)),
          backgroundColor: '#E67E22', borderRadius: 3 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 12, font: { size: 12 } } },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y}%` } },
      },
      scales: {
        y: { beginAtZero: true, max: 100, grid: { color: '#F0F0F0' },
             ticks: { callback: v => v + '%' } },
        x: { grid: { display: false }, ticks: { font: { size: 9 }, maxRotation: 60, minRotation: 45 } },
      },
    },
  });

  // Tabla de datos debajo (estilo Excel): filas FU y FO con el % por equipo.
  _renderTablaFUFO(filas);
}

// Tabla de valores alineada bajo el gráfico 1.
function _renderTablaFUFO(filas) {
  const cont = document.getElementById('tablaFUFO');
  if (!cont) return;
  if (!filas.length) { cont.innerHTML = ''; return; }

  const celdas = (key, color) => filas.map(x =>
    `<td style="text-align:center;color:${color};font-weight:600">${(x.f[key] * 100).toFixed(0)}%</td>`
  ).join('');

  cont.innerHTML = `
    <table class="fufo-table">
      <thead>
        <tr>
          <th></th>
          ${filas.map(x => `<th><div class="fufo-eq">${x.nombre}</div>${x.patente ? `<div class="fufo-pat">${x.patente}</div>` : ''}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="fufo-row-label" style="color:#2E86C1">■ FU</td>
          ${celdas('fu', '#1B5E89')}
        </tr>
        <tr>
          <td class="fufo-row-label" style="color:#E67E22">■ FO</td>
          ${celdas('fo', '#A85613')}
        </tr>
      </tbody>
    </table>`;
}

// ── Gráfico 2: desglose de tiempo por equipo (apilado % del total) + línea FU ──
function _renderChartDesglose(filas) {
  const ctx = document.getElementById('chartDesglose');
  if (!ctx) return;
  if (chartDesglose) chartDesglose.destroy();
  if (!filas.length) return;

  // Etiqueta en 2 líneas: nombre + patente (hay nombres repetidos).
  const labels = filas.map(x => x.patente ? [x.nombre, x.patente] : x.nombre);

  // Tres bloques por equipo (todos como % del total, suman 100):
  //  - Utilizado      = usadas ÷ total           (verde)
  //  - Operativo libre = operativo − utilizado    (azul)  → disponible no usado
  //  - No operativo   = 100 − operativo           (rojo)  → Panne, Mantención…
  const usado = filas.map(x => x.total > 0 ? (x.f.usadas / x.total) * 100 : 0);
  const operativoTot = filas.map(x => x.total > 0 ? (x.f.operativas / x.total) * 100 : 0);
  const fos = filas.map(x => +(x.f.fo * 100).toFixed(1));

  const r1 = (n) => +n.toFixed(1);
  const datasetsTareas = [
    {
      label: 'Utilizado',
      data: usado.map(r1),
      backgroundColor: '#27AE60',
      stack: 'tiempo', borderWidth: 0,
    },
    {
      label: 'Operativo no usado',
      data: filas.map((_, i) => r1(Math.max(0, operativoTot[i] - usado[i]))),
      backgroundColor: '#5DADE2',
      stack: 'tiempo', borderWidth: 0,
    },
    {
      label: 'No operativo',
      data: filas.map((_, i) => r1(Math.max(0, 100 - operativoTot[i]))),
      backgroundColor: '#E74C3C',
      stack: 'tiempo', borderWidth: 0,
    },
  ];

  chartDesglose = new Chart(ctx.getContext('2d'), {
    type: 'bar',
    data: { labels, datasets: datasetsTareas },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { boxWidth: 11, font: { size: 11 }, padding: 10 },
        },
        tooltip: {
          filter: (item) => item.parsed.y > 0,
          callbacks: {
            label: c => `${c.dataset.label}: ${c.parsed.y}%`,
            afterBody: (items) => {
              const i = items.length ? items[0].dataIndex : -1;
              if (i < 0) return '';
              return `FO ${fos[i]}%  ·  FU ${(filas[i].f.fu * 100).toFixed(1)}%`;
            },
          },
        },
      },
      scales: {
        y: { beginAtZero: true, max: 100, stacked: true, grid: { color: '#F0F0F0' },
             ticks: { stepSize: 20, callback: v => v + '%' } },
        x: { stacked: true, grid: { display: false },
             ticks: { font: { size: 10 }, maxRotation: 60, minRotation: 45 } },
      },
      onClick: (evt, els) => {
        if (!els.length) return;
        abrirDetalleFactor(filas[els[0].index]);
      },
    },
  });
}

let chartDetalleFactor = null;

// Clasifica una tarea en uno de los 3 grupos del análisis.
function grupoTarea(id) {
  const c = clasificacionDe(id);
  if (c.noOperativa) return 'noop';      // No operativo
  if (c.usoEfectivo) return 'usado';     // Utilizado
  return 'operativo';                    // Operativo no usado (disponible)
}

// Modal con el detalle de un equipo: 3 grupos con sus tareas + dona de horas.
function abrirDetalleFactor(x) {
  if (!x) return;
  const fo = (x.f.fo * 100).toFixed(1);
  const fu = (x.f.fu * 100).toFixed(1);

  // Tareas (con horas > 0) agrupadas.
  const tareas = Object.entries(x.horas).filter(([, h]) => h > 0);
  const grupos = {
    usado:     { label: 'Utilizado',          color: '#27AE60', tareas: [], horas: 0 },
    operativo: { label: 'Operativo no usado', color: '#5DADE2', tareas: [], horas: 0 },
    noop:      { label: 'No operativo',       color: '#E74C3C', tareas: [], horas: 0 },
  };
  tareas.forEach(([id, h]) => {
    const g = grupos[grupoTarea(id)];
    g.tareas.push([id, h]);
    g.horas += h;
  });

  // HTML de cada grupo con sus tareas.
  const bloque = (g) => {
    if (g.tareas.length === 0) return '';
    const filasTareas = g.tareas
      .sort((a, b) => b[1] - a[1])
      .map(([id, h]) => {
        const pct = x.total > 0 ? (h / x.total * 100).toFixed(1) : '0';
        return `<div class="det-tarea">
          <span><span class="det-dot" style="background:${colorTarea(id)}"></span>${etiquetaTarea(id)}</span>
          <span>${h.toFixed(1)} h · ${pct}%</span>
        </div>`;
      }).join('');
    const pctG = x.total > 0 ? (g.horas / x.total * 100).toFixed(1) : '0';
    return `<div class="det-grupo">
      <div class="det-grupo-head" style="border-left:4px solid ${g.color}">
        <span style="font-weight:700;color:${g.color}">${g.label}</span>
        <span style="font-weight:700">${g.horas.toFixed(1)} h · ${pctG}%</span>
      </div>
      ${filasTareas}
    </div>`;
  };

  document.getElementById('modalOpTitulo').textContent = x.nombre;
  document.getElementById('modalOpSub').textContent =
    `${x.patente || ''} · ${x.total.toFixed(1)} h totales · FO ${fo}% · FU ${fu}%`;
  document.getElementById('modalOpBody').innerHTML = `
    <div class="det-grid">
      <div class="det-chart"><canvas id="canvasDetalleFactor"></canvas></div>
      <div class="det-grupos">
        ${bloque(grupos.usado)}
        ${bloque(grupos.operativo)}
        ${bloque(grupos.noop)}
      </div>
    </div>`;
  document.getElementById('modalOperacion').classList.add('open');

  // Dona con las horas de cada tarea, AGRUPADA por tipo y con un separador
  // transparente entre grupos para distinguir cuánto pesa cada grupo.
  if (chartDetalleFactor) chartDetalleFactor.destroy();
  const cv = document.getElementById('canvasDetalleFactor');
  if (cv) {
    const labels = [];
    const data = [];
    const colors = [];
    // Tamaño del separador: ~3% del total (proporcional para que se note igual).
    const sep = (x.total || 1) * 0.03;
    const ordenGrupos = ['usado', 'operativo', 'noop'];
    ordenGrupos.forEach((gk, gi) => {
      const g = grupos[gk];
      if (!g.tareas.length) return;
      // Separador antes de cada grupo (excepto el primero con datos).
      if (data.length > 0) {
        labels.push('__sep'); data.push(sep); colors.push('rgba(0,0,0,0)');
      }
      g.tareas.sort((a, b) => b[1] - a[1]).forEach(([id, h]) => {
        labels.push(etiquetaTarea(id)); data.push(+h.toFixed(1)); colors.push(colorTarea(id));
      });
    });

    chartDetalleFactor = new Chart(cv.getContext('2d'), {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 1, borderColor: '#fff' }] },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '55%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              boxWidth: 10, font: { size: 10 }, padding: 6,
              // Oculta los separadores de la leyenda.
              filter: (item) => item.text !== '__sep',
            },
          },
          tooltip: {
            // Ignora los separadores en el tooltip.
            filter: (item) => item.label !== '__sep',
            callbacks: { label: c => `${c.label}: ${c.parsed} h` },
          },
        },
      },
    });
  }
}

// ---- Inicializar ----
updateTopbarDate();
document.getElementById('loadingOverlay').classList.remove('hidden');
window.addEventListener('load', () => { loadDashboard(); });
