// Reglas puras del modelo de licencias (sin base de datos): fechas, estados, cupo de usuarios y consumo de tokens.
// Son las unicas reglas del ecosistema: ningun producto repite esta logica.

// Fecha local AAAA-MM-DD en la zona horaria indicada (en-CA imprime exactamente ese formato).
export function fechaLocal(fecha = new Date(), zona = 'America/Lima') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit' }).format(fecha);
}
export const periodoDe = (fechaISO) => fechaISO.slice(0, 7);
export const diasPara = (fechaISO, hoyISO) => Math.round((Date.parse(`${fechaISO}T00:00:00Z`) - Date.parse(`${hoyISO}T00:00:00Z`)) / 86_400_000);
export function sumarDias(fechaISO, dias) {
  return new Date(Date.parse(`${fechaISO}T00:00:00Z`) + dias * 86_400_000).toISOString().slice(0, 10);
}
export function sumarMeses(fechaISO, meses) {
  const d = new Date(`${fechaISO}T00:00:00Z`);
  const dia = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + meses);
  const ultimo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(dia, ultimo));
  return d.toISOString().slice(0, 10);
}

// Estado real de la licencia segun la fecha: ACTIVA hasta el dia del vencimiento inclusive; luego SOLO_LECTURA
// durante soloLecturaDias; despues SUSPENDIDA. Una suspension o cancelacion manual se respeta tal cual.
export function estadoCalculado({ estado, vencimiento }, hoyISO, { soloLecturaDias = 7 } = {}) {
  if (estado === 'SUSPENDIDA' || estado === 'CANCELADA') return estado;
  const dias = diasPara(vencimiento, hoyISO);
  if (dias >= 0) return 'ACTIVA';
  return -dias > soloLecturaDias ? 'SUSPENDIDA' : 'SOLO_LECTURA';
}

export function evaluarCupo({ activos = 0, usuariosMax = 0 }) {
  return { puedeCrear: activos < usuariosMax, activos, usuariosMax, libres: Math.max(0, usuariosMax - activos) };
}

// Foto de la bolsa del periodo. capacidad = bolsa del mes + paquetes extra (usados este mes o aun disponibles).
export function resumenTokens({ bolsa = 0, consumidos = 0, deExtra = 0, restanteExtra = 0, tolerancia = 0, avisoPct = 80, toleranciaPct = 10 }) {
  const capacidad = bolsa + deExtra + restanteExtra;
  const usados = consumidos + deExtra;
  const disponibles = Math.max(0, capacidad - usados);
  const porcentaje = capacidad > 0 ? Math.round((usados / capacidad) * 100) : 100;
  const toleranciaMax = Math.ceil((capacidad * toleranciaPct) / 100);
  let nivel = 'normal';
  if (disponibles === 0) nivel = tolerancia < toleranciaMax ? 'tolerancia' : 'bloqueado';
  else if (porcentaje >= avisoPct) nivel = 'aviso';
  return { bolsa, extra: deExtra + restanteExtra, capacidad, usados, disponibles, porcentaje, tolerancia, toleranciaMax, nivel };
}

// Decide un consumo y dice de donde sale: primero la bolsa del mes, luego los paquetes extra, por ultimo la tolerancia.
// Lo hecho por Sulotec (administrador universal) nunca se bloquea, pero se descuenta y se marca.
export function evaluarConsumo({ estado = 'ACTIVA', cantidad = 1, hechoPorSulotec = false, ...tokens }) {
  const previo = resumenTokens(tokens);
  if (!Number.isInteger(cantidad) || cantidad < 1) return { ...previo, permitido: false, motivo: 'CANTIDAD_INVALIDA' };
  if (estado !== 'ACTIVA' && !hechoPorSulotec) {
    const motivo = estado === 'SOLO_LECTURA' ? 'SOLO_LECTURA' : estado === 'SUSPENDIDA' ? 'SUSPENDIDA' : 'SIN_LICENCIA';
    return { ...previo, permitido: false, motivo };
  }
  const bolsa = tokens.bolsa ?? 0;
  const consumidos = tokens.consumidos ?? 0;
  const deExtraPrevio = tokens.deExtra ?? 0;
  const restanteExtra = tokens.restanteExtra ?? 0;
  const toleranciaPrevia = tokens.tolerancia ?? 0;

  const deBolsa = Math.min(cantidad, Math.max(0, bolsa - consumidos));
  const deExtra = Math.min(cantidad - deBolsa, restanteExtra);
  const deTolerancia = cantidad - deBolsa - deExtra;
  if (deTolerancia > 0 && !hechoPorSulotec && toleranciaPrevia + deTolerancia > previo.toleranciaMax) {
    return { ...previo, permitido: false, motivo: 'BOLSA_AGOTADA' };
  }
  const nuevo = resumenTokens({
    ...tokens,
    consumidos: consumidos + deBolsa,
    deExtra: deExtraPrevio + deExtra,
    restanteExtra: restanteExtra - deExtra,
    tolerancia: toleranciaPrevia + deTolerancia,
  });
  const avisoPct = tokens.avisoPct ?? 80;
  const nivel = deTolerancia > 0 ? 'tolerancia' : nuevo.porcentaje >= avisoPct ? 'aviso' : 'normal';
  return {
    ...nuevo,
    permitido: true,
    nivel,
    reparto: { deBolsa, deExtra, deTolerancia },
    avisar: previo.porcentaje < avisoPct && nuevo.porcentaje >= avisoPct,
    avisarTolerancia: deTolerancia > 0 && toleranciaPrevia === 0,
  };
}
