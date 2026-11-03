// Operaciones del servicio sobre la base: lectura de licencias, cupo, consumo idempotente, administracion,
// «Mi licencia» y vencimientos. Las reglas puras estan en reglas.js; aqui solo se aplican.
import { consultar, transaccion } from '../bd.js';
import { config } from '../config.js';
import { ErrorApi } from '../errores.js';
import { esUuid, esFecha, esPeriodo, esCorreo, entero, texto, exigir } from '../validar.js';
import { generarToken, hashToken } from '../auth/productos.js';
import { evaluarConsumo, resumenTokens, evaluarCupo, estadoCalculado, diasPara, periodoDe, fechaLocal, sumarMeses } from './reglas.js';
import { enviar, plantillas } from './correos.js';

const bd = { query: consultar };
export const hoyLocal = () => fechaLocal(new Date(), config.zonaHoraria);
const json = (v) => (v == null ? null : JSON.stringify(v));
const enviarLuego = (correos) => { for (const m of correos) enviar(m).catch(() => {}); };

// ---------- reglas (parametros de negocio, con cache de 1 minuto) ----------
let cacheReglas = null;
let cacheHasta = 0;
export async function reglas(c = bd) {
  if (cacheReglas && cacheHasta > Date.now()) return cacheReglas;
  const { rows } = await c.query('SELECT clave, valor FROM reglas');
  const r = Object.fromEntries(rows.map((f) => [f.clave, Number(f.valor)]));
  cacheReglas = {
    avisoPct: r.aviso_porcentaje ?? 80,
    toleranciaPct: r.tolerancia_porcentaje ?? 10,
    avisoDias: r.vencimiento_aviso_dias ?? 7,
    soloLecturaDias: r.solo_lectura_dias ?? 7,
    extraMeses: r.bolsa_extra_vigencia_meses ?? 12,
  };
  cacheHasta = Date.now() + 60_000;
  return cacheReglas;
}
export const olvidarReglas = () => { cacheHasta = 0; };

export async function listarReglas() {
  const { rows } = await consultar('SELECT clave, valor, descripcion FROM reglas ORDER BY clave');
  return rows.map((f) => ({ ...f, valor: Number(f.valor) }));
}
export async function actualizarReglas(d, quien) {
  const claves = ['aviso_porcentaje', 'tolerancia_porcentaje', 'vencimiento_aviso_dias', 'solo_lectura_dias', 'bolsa_extra_vigencia_meses'];
  const cambios = Object.entries(d || {}).filter(([k]) => claves.includes(k));
  exigir(cambios.length > 0, `Indica alguna regla: ${claves.join(', ')}.`);
  for (const [k, v] of cambios) exigir(entero(v, 0) && v <= 1000, `${k} debe ser un entero entre 0 y 1000.`);
  const antes = await listarReglas();
  for (const [k, v] of cambios) await consultar('UPDATE reglas SET valor = $2 WHERE clave = $1', [k, String(v)]);
  olvidarReglas();
  const despues = await listarReglas();
  await bitacora(bd, quien, 'reglas', null, antes, despues);
  return despues;
}

const bitacora = (c, quien, accion, licenciaId, antes, despues) => c.query(
  'INSERT INTO bitacora (quien, accion, licencia_id, antes, despues) VALUES ($1, $2, $3, $4, $5)',
  [quien, accion, licenciaId, json(antes), json(despues)],
);

// ---------- lectura ----------
const SQL_LICENCIA = `SELECT l.*, p.nombre AS plan_nombre, pr.nombre AS producto_nombre, pr.usa_tokens
  FROM licencias l LEFT JOIN planes p ON p.id = l.plan_id JOIN productos pr ON pr.clave = l.producto`;

async function contexto(c, l, hoy) {
  const periodo = periodoDe(hoy);
  const p = await c.query('SELECT * FROM periodos WHERE licencia_id = $1 AND periodo = $2', [l.id, periodo]);
  const e = await c.query('SELECT id, restante, vence FROM bolsas_extra WHERE licencia_id = $1 AND restante > 0 AND vence >= $2 ORDER BY vence, id', [l.id, hoy]);
  const a = await c.query('SELECT activos FROM usuarios_activos WHERE licencia_id = $1', [l.id]);
  return {
    periodo,
    fila: p.rows[0] || { bolsa: l.tokens_periodo, consumidos: 0, de_extra: 0, tolerancia: 0, aviso_en: null },
    extras: e.rows,
    activos: a.rows[0]?.activos ?? 0,
  };
}

function vista(l, ctx, r, hoy) {
  const estado = estadoCalculado(l, hoy, r);
  const restanteExtra = ctx.extras.reduce((s, x) => s + x.restante, 0);
  const t = l.usa_tokens
    ? resumenTokens({ bolsa: ctx.fila.bolsa, consumidos: ctx.fila.consumidos, deExtra: ctx.fila.de_extra, restanteExtra, tolerancia: ctx.fila.tolerancia, avisoPct: r.avisoPct, toleranciaPct: r.toleranciaPct })
    : null;
  const cupo = evaluarCupo({ activos: ctx.activos, usuariosMax: l.usuarios_max });
  return {
    id: l.id,
    empresa_uuid: l.empresa_uuid,
    empresa_nombre: l.empresa_nombre,
    producto: l.producto,
    producto_nombre: l.producto_nombre,
    plan: l.plan_nombre ?? null,
    plan_id: l.plan_id ?? null,
    estado,
    usuarios_max: l.usuarios_max,
    usuarios_activos: ctx.activos,
    puede_crear_usuarios: estado === 'ACTIVA' && cupo.puedeCrear,
    periodo: ctx.periodo,
    tokens: t && { bolsa: t.bolsa, extra: t.extra, capacidad: t.capacidad, usados: t.usados, disponibles: t.disponibles, porcentaje: t.porcentaje, nivel: t.nivel, tolerancia: t.tolerancia, tolerancia_max: t.toleranciaMax },
    inicio: l.inicio,
    vencimiento: l.vencimiento,
    dias_para_vencer: diasPara(l.vencimiento, hoy),
    titular: { email: l.titular_email ?? null, nombre: l.titular_nombre ?? null },
    creado_en: l.creado_en,
  };
}

async function armarVista(c, l) {
  const hoy = hoyLocal();
  return vista(l, await contexto(c, l, hoy), await reglas(c), hoy);
}

export async function vistaPorId(id, c = bd) {
  const { rows } = await c.query(`${SQL_LICENCIA} WHERE l.id = $1`, [id]);
  if (!rows[0]) throw new ErrorApi(404, 'LICENCIA_NO_ENCONTRADA', 'No existe esa licencia.');
  return armarVista(c, rows[0]);
}

async function licenciaDe(c, empresaUuid, producto, bloquear = false) {
  const { rows } = await c.query(`${SQL_LICENCIA} WHERE l.empresa_uuid = $1 AND l.producto = $2${bloquear ? ' FOR UPDATE OF l' : ''}`, [empresaUuid, producto]);
  if (!rows[0]) throw new ErrorApi(404, 'SIN_LICENCIA', 'La empresa no tiene este producto contratado.');
  return rows[0];
}

export async function vistaDe(empresaUuid, producto) {
  return armarVista(bd, await licenciaDe(bd, empresaUuid, producto));
}

export async function cupoDe(empresaUuid, producto) {
  const v = await vistaDe(empresaUuid, producto);
  return { puede_crear: v.puede_crear_usuarios, activos: v.usuarios_activos, usuarios_max: v.usuarios_max, estado: v.estado };
}

export async function reportarActivos(empresaUuid, producto, activos) {
  exigir(entero(activos, 0), 'activos debe ser un entero mayor o igual a 0.');
  const l = await licenciaDe(bd, empresaUuid, producto);
  await consultar(
    'INSERT INTO usuarios_activos (licencia_id, activos, reportado_en) VALUES ($1, $2, now()) ON CONFLICT (licencia_id) DO UPDATE SET activos = EXCLUDED.activos, reportado_en = now()',
    [l.id, activos],
  );
  return cupoDe(empresaUuid, producto);
}

// ---------- consumo de tokens ----------
async function registrarAviso(c, licenciaId, tipo, periodo, destinatario) {
  const { rows } = await c.query(
    'INSERT INTO avisos (licencia_id, tipo, periodo, destinatario) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id',
    [licenciaId, tipo, periodo, destinatario],
  );
  return Boolean(rows[0]);
}

export async function consumir(productoClave, empresaUuid, datos) {
  const clave = datos.clave_idempotente;
  const cantidad = datos.cantidad ?? 1;
  const porSulotec = datos.hecho_por_sulotec === true;
  exigir(texto(clave, 200), 'clave_idempotente es obligatoria (texto de hasta 200 caracteres, única por consulta).');
  exigir(texto(datos.tipo, 60), 'tipo es obligatorio (qué se consumió, por ejemplo consulta_reniec).');
  exigir(entero(cantidad, 1) && cantidad <= 1000, 'cantidad debe ser un entero entre 1 y 1000.');
  exigir(datos.usuario == null || texto(datos.usuario, 200), 'usuario debe ser un texto corto.');

  const { respuesta, correos } = await transaccion(async (c) => {
    const previo = await c.query('SELECT respuesta FROM consumos WHERE clave_idempotente = $1', [clave]);
    if (previo.rows[0]) return { respuesta: { ...previo.rows[0].respuesta, repetido: true }, correos: [] };

    const l = await licenciaDe(c, empresaUuid, productoClave, true);
    if (!l.usa_tokens) throw new ErrorApi(400, 'PRODUCTO_SIN_TOKENS', 'Este producto se licencia solo por usuarios; no consume tokens.');
    const hoy = hoyLocal();
    const r = await reglas(c);
    const ctx = await contexto(c, l, hoy);
    const estado = estadoCalculado(l, hoy, r);
    const restanteExtra = ctx.extras.reduce((s, x) => s + x.restante, 0);
    const ev = evaluarConsumo({
      estado, cantidad, hechoPorSulotec: porSulotec,
      bolsa: ctx.fila.bolsa, consumidos: ctx.fila.consumidos, deExtra: ctx.fila.de_extra, restanteExtra, tolerancia: ctx.fila.tolerancia,
      avisoPct: r.avisoPct, toleranciaPct: r.toleranciaPct,
    });
    const correos = [];
    const comun = { disponibles: ev.disponibles, porcentaje: ev.porcentaje, capacidad: ev.capacidad, usados: ev.usados, periodo: ctx.periodo };
    if (!ev.permitido) {
      if (ev.motivo === 'BOLSA_AGOTADA' && l.titular_email && await registrarAviso(c, l.id, 'bloqueo', ctx.periodo, l.titular_email)) {
        correos.push({ para: l.titular_email, ...plantillas.bloqueo(l, ev) });
      }
      return { respuesta: { permitido: false, motivo: ev.motivo, ...comun }, correos };
    }

    // Paquetes extra: se gastan en orden de vencimiento.
    let porRepartir = ev.reparto.deExtra;
    const extrasUsados = [];
    for (const x of ctx.extras) {
      if (!porRepartir) break;
      const q = Math.min(porRepartir, x.restante);
      await c.query('UPDATE bolsas_extra SET restante = restante - $2 WHERE id = $1', [x.id, q]);
      extrasUsados.push({ id: x.id, cantidad: q });
      porRepartir -= q;
    }
    await c.query(
      `INSERT INTO periodos (licencia_id, periodo, bolsa, consumidos, de_extra, tolerancia) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (licencia_id, periodo) DO UPDATE SET consumidos = periodos.consumidos + EXCLUDED.consumidos,
         de_extra = periodos.de_extra + EXCLUDED.de_extra, tolerancia = periodos.tolerancia + EXCLUDED.tolerancia`,
      [l.id, ctx.periodo, ctx.fila.bolsa, ev.reparto.deBolsa, ev.reparto.deExtra, ev.reparto.deTolerancia],
    );
    const respuesta = { permitido: true, nivel: ev.nivel, ...comun };
    await c.query(
      `INSERT INTO consumos (licencia_id, periodo, usuario, tipo, cantidad, hecho_por_sulotec, nivel, de_bolsa, de_extra, de_tolerancia, extras_usados, clave_idempotente, detalle, respuesta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [l.id, ctx.periodo, datos.usuario ?? null, datos.tipo, cantidad, porSulotec, ev.nivel, ev.reparto.deBolsa, ev.reparto.deExtra, ev.reparto.deTolerancia,
        JSON.stringify(extrasUsados), clave, json(datos.detalle ?? null), JSON.stringify(respuesta)],
    );
    if (!porSulotec && l.titular_email) {
      if (ev.avisar && !ctx.fila.aviso_en) {
        await c.query('UPDATE periodos SET aviso_en = now() WHERE licencia_id = $1 AND periodo = $2', [l.id, ctx.periodo]);
        if (await registrarAviso(c, l.id, 'aviso', ctx.periodo, l.titular_email)) correos.push({ para: l.titular_email, ...plantillas.aviso(l, ev, r) });
      }
      if (ev.avisarTolerancia && await registrarAviso(c, l.id, 'tolerancia', ctx.periodo, l.titular_email)) {
        correos.push({ para: l.titular_email, ...plantillas.tolerancia(l, ev, r) });
      }
    }
    return { respuesta, correos };
  });
  enviarLuego(correos);
  return respuesta;
}

export async function anularConsumo(productoClave, clave) {
  return transaccion(async (c) => {
    const { rows } = await c.query('SELECT co.*, l.producto FROM consumos co JOIN licencias l ON l.id = co.licencia_id WHERE co.clave_idempotente = $1 FOR UPDATE OF co', [clave]);
    const co = rows[0];
    if (!co || co.producto !== productoClave) throw new ErrorApi(404, 'CONSUMO_NO_ENCONTRADO', 'No hay un consumo con esa clave.');
    if (co.anulado_en) return { anulado: true, repetido: true };
    await c.query(
      'UPDATE periodos SET consumidos = GREATEST(0, consumidos - $3), de_extra = GREATEST(0, de_extra - $4), tolerancia = GREATEST(0, tolerancia - $5) WHERE licencia_id = $1 AND periodo = $2',
      [co.licencia_id, co.periodo, co.de_bolsa, co.de_extra, co.de_tolerancia],
    );
    for (const x of co.extras_usados) await c.query('UPDATE bolsas_extra SET restante = restante + $2 WHERE id = $1', [x.id, x.cantidad]);
    await c.query('UPDATE consumos SET anulado_en = now() WHERE id = $1', [co.id]);
    return { anulado: true };
  });
}

// ---------- administracion (Administrador Universal) ----------
export async function listarProductos() {
  const { rows } = await consultar('SELECT clave, nombre, usa_tokens, token_hash IS NOT NULL AS tiene_token, token_rotado_en FROM productos ORDER BY nombre');
  return rows;
}

export async function rotarToken(clave, quien) {
  const token = generarToken(clave);
  const r = await consultar('UPDATE productos SET token_hash = $2, token_rotado_en = now() WHERE clave = $1', [clave, hashToken(token)]);
  if (!r.rowCount) throw new ErrorApi(404, 'PRODUCTO_NO_ENCONTRADO', 'No existe ese producto.');
  await bitacora(bd, quien, 'rotar_token', null, null, { producto: clave });
  return { producto: clave, token, aviso: 'Guárdalo ahora en el .env del producto (LICENCIAS_TOKEN): no se vuelve a mostrar.' };
}

const planVista = (p) => ({ ...p, precio: p.precio == null ? null : Number(p.precio) });

export async function listarPlanes(producto) {
  const { rows } = await consultar(`SELECT * FROM planes${producto ? ' WHERE producto = $1' : ''} ORDER BY producto, usuarios_max, nombre`, producto ? [producto] : []);
  return rows.map(planVista);
}

function validarPlan(d, parcial = false) {
  if (!parcial || d.nombre !== undefined) exigir(texto(d.nombre, 80), 'nombre es obligatorio (hasta 80 caracteres).');
  if (!parcial || d.usuarios_max !== undefined) exigir(entero(d.usuarios_max, 0), 'usuarios_max debe ser un entero mayor o igual a 0.');
  if (d.tokens_periodo !== undefined) exigir(entero(d.tokens_periodo, 0), 'tokens_periodo debe ser un entero mayor o igual a 0.');
  if (d.precio !== undefined && d.precio !== null) exigir(typeof d.precio === 'number' && d.precio >= 0, 'precio debe ser un número mayor o igual a 0.');
  if (d.activo !== undefined) exigir(typeof d.activo === 'boolean', 'activo debe ser true o false.');
}

export async function crearPlan(d, quien) {
  validarPlan(d);
  const pr = (await consultar('SELECT clave, usa_tokens FROM productos WHERE clave = $1', [d.producto])).rows[0];
  exigir(pr, 'producto no existe.');
  exigir(pr.usa_tokens || !d.tokens_periodo, 'Este producto no usa tokens: tokens_periodo debe ser 0.');
  const { rows } = await consultar(
    'INSERT INTO planes (producto, nombre, usuarios_max, tokens_periodo, precio) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (producto, nombre) DO NOTHING RETURNING *',
    [d.producto, d.nombre.trim(), d.usuarios_max, d.tokens_periodo ?? 0, d.precio ?? null],
  );
  if (!rows[0]) throw new ErrorApi(409, 'PLAN_DUPLICADO', 'Ya existe un plan con ese nombre para ese producto.');
  await bitacora(bd, quien, 'crear_plan', null, null, rows[0]);
  return planVista(rows[0]);
}

export async function actualizarPlan(id, d, quien) {
  validarPlan(d, true);
  const antes = (await consultar('SELECT * FROM planes WHERE id = $1', [id])).rows[0];
  if (!antes) throw new ErrorApi(404, 'PLAN_NO_ENCONTRADO', 'No existe ese plan.');
  const set = {};
  for (const k of ['nombre', 'usuarios_max', 'tokens_periodo', 'precio', 'activo']) if (d[k] !== undefined) set[k] = k === 'nombre' ? d[k].trim() : d[k];
  const cols = Object.keys(set);
  exigir(cols.length > 0, 'No hay nada que cambiar.');
  const { rows } = await consultar(`UPDATE planes SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [id, ...cols.map((k) => set[k])]);
  await bitacora(bd, quien, 'actualizar_plan', null, antes, rows[0]);
  return planVista(rows[0]);
}

export async function listarLicencias({ producto, empresa, estado } = {}) {
  const cond = [];
  const params = [];
  if (producto) { params.push(producto); cond.push(`l.producto = $${params.length}`); }
  if (empresa) { exigir(esUuid(empresa), 'empresa debe ser un UUID.'); params.push(empresa.toLowerCase()); cond.push(`l.empresa_uuid = $${params.length}`); }
  const { rows } = await consultar(`${SQL_LICENCIA}${cond.length ? ` WHERE ${cond.join(' AND ')}` : ''} ORDER BY l.empresa_nombre, l.producto`, params);
  const vistas = [];
  for (const l of rows) vistas.push(await armarVista(bd, l));
  return estado ? vistas.filter((v) => v.estado === estado) : vistas;
}

export async function crearLicencia(d, quien) {
  exigir(esUuid(d.empresa_uuid), 'empresa_uuid debe ser el UUID de la empresa (el mismo de Keycloak).');
  exigir(texto(d.empresa_nombre, 200), 'empresa_nombre es obligatorio.');
  exigir(d.titular_email == null || esCorreo(d.titular_email), 'titular_email no es un correo válido.');
  exigir(d.titular_nombre == null || texto(d.titular_nombre, 200), 'titular_nombre debe ser un texto corto.');
  const hoy = hoyLocal();
  const v = await transaccion(async (c) => {
    const pr = (await c.query('SELECT * FROM productos WHERE clave = $1', [d.producto])).rows[0];
    exigir(pr, 'producto no existe.');
    let plan = null;
    if (d.plan_id != null) {
      plan = (await c.query('SELECT * FROM planes WHERE id = $1 AND producto = $2', [d.plan_id, d.producto])).rows[0];
      exigir(plan, 'plan_id no corresponde a ese producto.');
    }
    const usuariosMax = d.usuarios_max ?? plan?.usuarios_max;
    const tokensPeriodo = d.tokens_periodo ?? plan?.tokens_periodo ?? 0;
    exigir(entero(usuariosMax, 0), 'usuarios_max es obligatorio (o elige un plan).');
    exigir(entero(tokensPeriodo, 0), 'tokens_periodo debe ser un entero mayor o igual a 0.');
    exigir(pr.usa_tokens || tokensPeriodo === 0, 'Este producto no usa tokens: tokens_periodo debe ser 0.');
    const inicio = d.inicio ?? hoy;
    exigir(esFecha(inicio), 'inicio debe ser una fecha AAAA-MM-DD.');
    const vencimiento = d.vencimiento ?? sumarMeses(inicio, 1);
    exigir(esFecha(vencimiento) && vencimiento >= inicio, 'vencimiento debe ser una fecha AAAA-MM-DD posterior al inicio.');
    const ins = await c.query(
      `INSERT INTO licencias (empresa_uuid, empresa_nombre, producto, plan_id, usuarios_max, tokens_periodo, inicio, vencimiento, titular_email, titular_nombre, creado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (empresa_uuid, producto) DO NOTHING RETURNING id`,
      [d.empresa_uuid.toLowerCase(), d.empresa_nombre.trim(), d.producto, plan?.id ?? null, usuariosMax, tokensPeriodo, inicio, vencimiento, d.titular_email ?? null, d.titular_nombre ?? null, quien],
    );
    if (!ins.rows[0]) throw new ErrorApi(409, 'LICENCIA_DUPLICADA', 'La empresa ya tiene una licencia de este producto: amplíala, renuévala o cámbiale el plan.');
    const v = await vistaPorId(ins.rows[0].id, c);
    await bitacora(c, quien, 'crear_licencia', v.id, null, v);
    return v;
  });
  if (v.titular?.email) enviarLuego([{ para: v.titular.email, ...plantillas.licenciaCreada(v) }]);
  return v;
}

const ACCIONES = ['ampliar', 'renovar', 'cambiar_plan', 'suspender', 'reactivar', 'cancelar', 'titular'];

export async function modificarLicencia(id, d, quien) {
  exigir(ACCIONES.includes(d.accion), `accion debe ser una de: ${ACCIONES.join(', ')}.`);
  const hoy = hoyLocal();
  return transaccion(async (c) => {
    const { rows } = await c.query(`${SQL_LICENCIA} WHERE l.id = $1 FOR UPDATE OF l`, [id]);
    const l = rows[0];
    if (!l) throw new ErrorApi(404, 'LICENCIA_NO_ENCONTRADA', 'No existe esa licencia.');
    const antes = await armarVista(c, l);
    const set = {};
    switch (d.accion) {
      case 'ampliar':
        if (d.usuarios_max !== undefined) { exigir(entero(d.usuarios_max, 0), 'usuarios_max debe ser un entero mayor o igual a 0.'); set.usuarios_max = d.usuarios_max; }
        if (d.tokens_periodo !== undefined) { exigir(entero(d.tokens_periodo, 0), 'tokens_periodo debe ser un entero mayor o igual a 0.'); exigir(l.usa_tokens, 'Este producto no usa tokens.'); set.tokens_periodo = d.tokens_periodo; }
        exigir(Object.keys(set).length > 0, 'Indica usuarios_max o tokens_periodo.');
        break;
      case 'renovar':
        exigir(esFecha(d.vencimiento) && d.vencimiento >= hoy, 'vencimiento debe ser una fecha AAAA-MM-DD de hoy en adelante.');
        set.vencimiento = d.vencimiento;
        set.estado = 'ACTIVA';
        break;
      case 'cambiar_plan': {
        const plan = (await c.query('SELECT * FROM planes WHERE id = $1 AND producto = $2', [d.plan_id, l.producto])).rows[0];
        exigir(plan, 'plan_id no corresponde a ese producto.');
        set.plan_id = plan.id; set.usuarios_max = plan.usuarios_max; set.tokens_periodo = plan.tokens_periodo;
        break;
      }
      case 'suspender': set.estado = 'SUSPENDIDA'; break;
      case 'cancelar': set.estado = 'CANCELADA'; break;
      case 'reactivar':
        if (d.vencimiento !== undefined) { exigir(esFecha(d.vencimiento), 'vencimiento debe ser una fecha AAAA-MM-DD.'); set.vencimiento = d.vencimiento; }
        exigir((set.vencimiento ?? l.vencimiento) >= hoy, 'La licencia está vencida: indica un vencimiento nuevo para reactivarla.');
        set.estado = 'ACTIVA';
        break;
      case 'titular':
        exigir(esCorreo(d.email), 'email no es un correo válido.');
        exigir(d.nombre == null || texto(d.nombre, 200), 'nombre debe ser un texto corto.');
        set.titular_email = d.email; set.titular_nombre = d.nombre ?? null;
        break;
      default: break;
    }
    const cols = Object.keys(set);
    await c.query(`UPDATE licencias SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, actualizado_en = now() WHERE id = $1`, [id, ...cols.map((k) => set[k])]);
    if (set.tokens_periodo !== undefined) await c.query('UPDATE periodos SET bolsa = $2 WHERE licencia_id = $1 AND periodo = $3', [id, set.tokens_periodo, periodoDe(hoy)]);
    const despues = await vistaPorId(id, c);
    await bitacora(c, quien, d.accion, id, antes, despues);
    return despues;
  });
}

export async function agregarBolsaExtra(id, d, quien) {
  exigir(entero(d.cantidad, 1), 'cantidad debe ser un entero mayor que 0.');
  const hoy = hoyLocal();
  const r = await reglas();
  const vence = d.vence ?? sumarMeses(hoy, r.extraMeses);
  exigir(esFecha(vence) && vence >= hoy, 'vence debe ser una fecha AAAA-MM-DD de hoy en adelante.');
  return transaccion(async (c) => {
    const { rows } = await c.query(`${SQL_LICENCIA} WHERE l.id = $1 FOR UPDATE OF l`, [id]);
    const l = rows[0];
    if (!l) throw new ErrorApi(404, 'LICENCIA_NO_ENCONTRADA', 'No existe esa licencia.');
    exigir(l.usa_tokens, 'Este producto no usa tokens.');
    await c.query('INSERT INTO bolsas_extra (licencia_id, cantidad, restante, vence, creado_por) VALUES ($1, $2, $2, $3, $4)', [id, d.cantidad, vence, quien]);
    const v = await vistaPorId(id, c);
    await bitacora(c, quien, 'bolsa_extra', id, { cantidad: d.cantidad, vence }, v.tokens);
    return v;
  });
}

export async function consumosDe(licenciaId, periodo) {
  exigir(!periodo || esPeriodo(periodo), 'periodo debe ser AAAA-MM.');
  const { rows } = await consultar(
    `SELECT id, periodo, usuario, tipo, cantidad, nivel, hecho_por_sulotec, de_tolerancia, anulado_en, creado_en FROM consumos
     WHERE licencia_id = $1 AND periodo = $2 ORDER BY creado_en DESC LIMIT 2000`,
    [licenciaId, periodo || periodoDe(hoyLocal())],
  );
  return rows;
}

export async function reporteConsumos({ periodo_desde: desde, periodo_hasta: hasta, producto, empresa } = {}) {
  const actual = periodoDe(hoyLocal());
  desde = desde || actual;
  hasta = hasta || desde;
  exigir(esPeriodo(desde) && esPeriodo(hasta) && desde <= hasta, 'periodo_desde y periodo_hasta deben ser AAAA-MM, en orden.');
  const cond = ['co.anulado_en IS NULL', 'co.periodo >= $1', 'co.periodo <= $2'];
  const params = [desde, hasta];
  if (producto) { params.push(producto); cond.push(`l.producto = $${params.length}`); }
  if (empresa) { exigir(esUuid(empresa), 'empresa debe ser un UUID.'); params.push(empresa.toLowerCase()); cond.push(`l.empresa_uuid = $${params.length}`); }
  const { rows } = await consultar(
    `SELECT co.creado_en, l.empresa_uuid, l.empresa_nombre, l.producto, pr.nombre AS producto_nombre, co.periodo, co.usuario, co.tipo, co.cantidad, co.nivel,
            co.hecho_por_sulotec, co.de_bolsa, co.de_extra, co.de_tolerancia
     FROM consumos co JOIN licencias l ON l.id = co.licencia_id JOIN productos pr ON pr.clave = l.producto
     WHERE ${cond.join(' AND ')} ORDER BY co.creado_en`,
    params,
  );
  const grupos = new Map();
  for (const f of rows) {
    const k = `${f.empresa_uuid}|${f.producto}|${f.periodo}`;
    const g = grupos.get(k) || { empresa_uuid: f.empresa_uuid, empresa_nombre: f.empresa_nombre, producto: f.producto, producto_nombre: f.producto_nombre, periodo: f.periodo, consultas: 0, tokens: 0, de_bolsa: 0, de_extra: 0, tolerancia: 0, hecho_por_sulotec: 0 };
    g.consultas += 1;
    g.tokens += f.cantidad;
    g.de_bolsa += f.de_bolsa;
    g.de_extra += f.de_extra;
    g.tolerancia += f.de_tolerancia;
    if (f.hecho_por_sulotec) g.hecho_por_sulotec += f.cantidad;
    grupos.set(k, g);
  }
  return { periodo_desde: desde, periodo_hasta: hasta, resumen: [...grupos.values()], detalle: rows };
}

export async function listarSolicitudes({ pendientes } = {}) {
  const { rows } = await consultar(
    `SELECT s.*, l.empresa_uuid, l.empresa_nombre, l.producto FROM solicitudes s JOIN licencias l ON l.id = s.licencia_id
     ${pendientes ? 'WHERE s.atendido_en IS NULL' : ''} ORDER BY s.creado_en DESC LIMIT 500`,
  );
  return rows;
}

export async function atenderSolicitud(id, quien) {
  const { rows } = await consultar('UPDATE solicitudes SET atendido_en = now(), atendido_por = $2 WHERE id = $1 AND atendido_en IS NULL RETURNING *', [id, quien]);
  if (!rows[0]) throw new ErrorApi(404, 'SOLICITUD_NO_ENCONTRADA', 'No existe esa solicitud o ya fue atendida.');
  return rows[0];
}

export async function listarBitacora({ licencia, limite } = {}) {
  const n = Math.min(Number(limite) || 100, 1000);
  const { rows } = licencia
    ? await consultar('SELECT * FROM bitacora WHERE licencia_id = $1 ORDER BY cuando DESC LIMIT $2', [licencia, n])
    : await consultar('SELECT * FROM bitacora ORDER BY cuando DESC LIMIT $1', [n]);
  return rows;
}

// ---------- «Mi licencia» (Administrador General de la empresa) ----------
const esTitular = (persona, licencias) => licencias.some((l) => l.titular_email && persona.email && l.titular_email.toLowerCase() === persona.email.toLowerCase());

function empresaDe(persona, forzada) {
  const empresa = persona.universal && forzada ? forzada : persona.empresaUuid;
  if (!empresa) throw new ErrorApi(403, 'SIN_EMPRESA', 'Tu cuenta Sulotec no pertenece a ninguna empresa.');
  exigir(esUuid(empresa), 'empresa debe ser un UUID.');
  return empresa.toLowerCase();
}

export async function misLicencias(persona, forzada) {
  const empresa = empresaDe(persona, forzada);
  const { rows } = await consultar(`${SQL_LICENCIA} WHERE l.empresa_uuid = $1 ORDER BY l.producto`, [empresa]);
  if (rows.length && !persona.universal && !esTitular(persona, rows)) {
    throw new ErrorApi(403, 'SOLO_TITULAR', 'Solo el Administrador General de tu empresa (titular de la licencia) puede ver esto.');
  }
  const vistas = [];
  for (const l of rows) vistas.push(await armarVista(bd, l));
  return vistas;
}

async function miLicencia(persona, producto, forzada) {
  const empresa = empresaDe(persona, forzada);
  const { rows } = await consultar(`${SQL_LICENCIA} WHERE l.empresa_uuid = $1 ORDER BY l.producto`, [empresa]);
  if (!persona.universal && !esTitular(persona, rows)) throw new ErrorApi(403, 'SOLO_TITULAR', 'Solo el Administrador General de tu empresa (titular de la licencia) puede ver esto.');
  const l = rows.find((x) => x.producto === producto);
  if (!l) throw new ErrorApi(404, 'SIN_LICENCIA', 'Tu empresa no tiene este producto contratado.');
  return l;
}

export async function misConsumos(persona, producto, periodo, forzada) {
  const l = await miLicencia(persona, producto, forzada);
  return consumosDe(l.id, periodo);
}

export async function solicitarAmpliacion(persona, producto, d, forzada) {
  exigir(['usuarios', 'tokens', 'plan'].includes(d.que), 'que debe ser usuarios, tokens o plan.');
  exigir(d.cantidad == null || entero(d.cantidad, 1), 'cantidad debe ser un entero mayor que 0.');
  exigir(d.comentario == null || (typeof d.comentario === 'string' && d.comentario.length <= 500), 'comentario: hasta 500 caracteres.');
  const l = await miLicencia(persona, producto, forzada);
  const { rows } = await consultar(
    'INSERT INTO solicitudes (licencia_id, que, cantidad, comentario, solicitado_por) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [l.id, d.que, d.cantidad ?? null, d.comentario?.trim() || null, persona.email || persona.usuario],
  );
  enviarLuego([{ para: config.correo.contacto, ...plantillas.solicitud(l, rows[0]) }]);
  return rows[0];
}

// ---------- vencimientos (tarea periodica, idempotente) ----------
export async function aplicarVencimientos(hoy = hoyLocal()) {
  const r = await reglas();
  const { rows } = await consultar(`${SQL_LICENCIA} WHERE l.estado IN ('ACTIVA', 'SOLO_LECTURA')`);
  const correos = [];
  let cambios = 0;
  for (const l of rows) {
    const nuevo = estadoCalculado(l, hoy, r);
    if (nuevo !== l.estado) {
      await consultar('UPDATE licencias SET estado = $2, actualizado_en = now() WHERE id = $1', [l.id, nuevo]);
      await bitacora(bd, 'sistema', nuevo === 'SOLO_LECTURA' ? 'vencida' : 'suspendida', l.id, { estado: l.estado }, { estado: nuevo, vencimiento: l.vencimiento });
      cambios += 1;
    }
    const dias = diasPara(l.vencimiento, hoy);
    let tipo = null;
    if (nuevo === 'SUSPENDIDA') tipo = 'suspendida';
    else if (nuevo === 'SOLO_LECTURA') tipo = 'vencida';
    else if (dias <= r.avisoDias) tipo = 'vence';
    if (tipo && l.titular_email && await registrarAviso(bd, l.id, tipo, l.vencimiento, l.titular_email)) {
      correos.push({ para: l.titular_email, ...plantillas[tipo](l, dias, r) });
    }
  }
  for (const m of correos) await enviar(m);
  return { revisadas: rows.length, cambios, avisos: correos.length };
}
