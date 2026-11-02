// Prueba de punta a punta contra un PostgreSQL real. Usa DATABASE_URL_PRUEBA si existe; si no, levanta un PostgreSQL
// embebido (paquete embedded-postgres, solo en desarrollo) en una carpeta temporal y lo borra al terminar.
//   npm test
//   DATABASE_URL_PRUEBA=postgresql://postgres:prueba@localhost:55432/licencias npm test   (contra una base propia)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

const url = process.env.DATABASE_URL_PRUEBA;
const Embebido = url ? null : await import('embedded-postgres').then((m) => m.default).catch(() => null);
if (!url && !Embebido) {
  test('API de punta a punta (omitida: falta DATABASE_URL_PRUEBA y no está instalado embedded-postgres)', { skip: true }, () => {});
} else {
  const EMISOR = 'https://cuenta.prueba/realms/sulotec';
  const EMPRESA = '7b1f2d4e-5c6a-4b8d-9e0f-1a2b3c4d5e6f';
  const hoy = new Date().toISOString().slice(0, 10);
  const sumar = (d) => new Date(Date.parse(`${hoy}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
  let servidor; let base; let pool; let firmar; let tokenMiradar; let tokenGeo; let universal; let titular; let otro; let embebido;

  const llamar = async (metodo, ruta, { token, cuerpo, crudo } = {}) => {
    const r = await fetch(`${base}${ruta}`, {
      method: metodo,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    if (crudo) return r;
    const datos = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
    return { estado: r.status, datos };
  };

  before(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'prueba', alg: 'RS256', use: 'sig' };
    let urlBd = url;
    if (!urlBd) {
      const puerto = 55000 + Math.floor(Math.random() * 1000);
      embebido = new Embebido({ databaseDir: join(tmpdir(), `licencias-pg-${process.pid}`), user: 'postgres', password: 'prueba', port: puerto, persistent: false, onLog: () => {}, onError: () => {} });
      await embebido.initialise();
      await embebido.start();
      urlBd = `postgresql://postgres:prueba@127.0.0.1:${puerto}/postgres`;
    }
    process.env.DATABASE_URL = urlBd;
    process.env.KEYCLOAK_ISSUER = EMISOR;
    process.env.KEYCLOAK_AUDIENCE = 'licencias';
    process.env.KEYCLOAK_JWKS_LOCAL = JSON.stringify({ keys: [jwk] });
    process.env.TAREAS = '0';
    process.env.SMTP_HOST = '';
    firmar = (claims) => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'prueba' }).setIssuer(EMISOR).setAudience('licencias').setIssuedAt().setExpirationTime('10m').sign(privateKey);
    universal = await firmar({ preferred_username: 'uni', email: 'uni@sulotec.com', name: 'Uni Versal', roles: ['administrador-general'] });
    titular = await firmar({ preferred_username: 'ana', email: 'ana@empresa.pe', name: 'Ana', roles: ['producto-miradar360'], empresa_uuid: EMPRESA, empresa_nombre: 'Empresa Prueba' });
    otro = await firmar({ preferred_username: 'luis', email: 'luis@empresa.pe', name: 'Luis', roles: ['producto-miradar360'], empresa_uuid: EMPRESA });

    const bd = await import('../src/bd.js');
    pool = bd.pool;
    await bd.migrar();
    await pool.query('TRUNCATE licencias, planes, bitacora, solicitudes RESTART IDENTITY CASCADE');
    await pool.query("UPDATE productos SET token_hash = NULL");
    const { generarToken, hashToken } = await import('../src/auth/productos.js');
    tokenMiradar = generarToken('miradar360');
    tokenGeo = generarToken('geomatrix');
    await pool.query('UPDATE productos SET token_hash = $2 WHERE clave = $1', ['miradar360', hashToken(tokenMiradar)]);
    await pool.query('UPDATE productos SET token_hash = $2 WHERE clave = $1', ['geomatrix', hashToken(tokenGeo)]);
    const { crearApp } = await import('../src/app.js');
    servidor = crearApp().listen(0);
    base = `http://127.0.0.1:${servidor.address().port}`;
  });

  after(async () => {
    servidor?.close();
    await pool?.end();
    await embebido?.stop();
  });

  test('salud y autenticacion', async () => {
    assert.equal((await llamar('GET', '/health')).datos.ok, true);
    assert.equal((await llamar('GET', `/v1/licencias/${EMPRESA}`)).estado, 401);
    assert.equal((await llamar('GET', `/v1/licencias/${EMPRESA}`, { token: 'miradar360.falso' })).estado, 401);
    assert.equal((await llamar('GET', '/v1/admin/planes')).estado, 401);
    assert.equal((await llamar('GET', '/v1/admin/planes', { token: titular })).estado, 403);
  });

  let planId; let licenciaId;
  test('el universal crea un plan y una licencia', async () => {
    const plan = await llamar('POST', '/v1/admin/planes', { token: universal, cuerpo: { producto: 'miradar360', nombre: 'Básico', usuarios_max: 3, tokens_periodo: 10, precio: 100 } });
    assert.equal(plan.estado, 201, JSON.stringify(plan.datos));
    planId = plan.datos.id;
    const dup = await llamar('POST', '/v1/admin/planes', { token: universal, cuerpo: { producto: 'miradar360', nombre: 'Básico', usuarios_max: 3 } });
    assert.equal(dup.estado, 409);
    const lic = await llamar('POST', '/v1/admin/licencias', { token: universal, cuerpo: { empresa_uuid: EMPRESA, empresa_nombre: 'Empresa Prueba', producto: 'miradar360', plan_id: planId, vencimiento: sumar(30), titular_email: 'ana@empresa.pe', titular_nombre: 'Ana' } });
    assert.equal(lic.estado, 201, JSON.stringify(lic.datos));
    licenciaId = lic.datos.id;
    assert.equal(lic.datos.estado, 'ACTIVA');
    assert.equal(lic.datos.tokens.bolsa, 10);
    assert.equal(lic.datos.plan, 'Básico');
    const dup2 = await llamar('POST', '/v1/admin/licencias', { token: universal, cuerpo: { empresa_uuid: EMPRESA, empresa_nombre: 'Empresa Prueba', producto: 'miradar360', usuarios_max: 1 } });
    assert.equal(dup2.estado, 409);
    const mal = await llamar('POST', '/v1/admin/licencias', { token: universal, cuerpo: { empresa_uuid: 'no-es-uuid', empresa_nombre: 'X', producto: 'miradar360', usuarios_max: 1 } });
    assert.equal(mal.estado, 400);
  });

  test('el producto lee su licencia, el cupo y reporta usuarios', async () => {
    const v = await llamar('GET', `/v1/licencias/${EMPRESA}`, { token: tokenMiradar });
    assert.equal(v.estado, 200);
    assert.equal(v.datos.puede_crear_usuarios, true);
    assert.equal(v.datos.tokens.disponibles, 10);
    assert.equal((await llamar('GET', `/v1/licencias/${EMPRESA}`, { token: tokenGeo })).estado, 404, 'otro producto no ve esta licencia');
    assert.equal((await llamar('GET', `/v1/licencias/${EMPRESA}/cupo`, { token: tokenMiradar })).datos.puede_crear, true);
    const rep = await llamar('PUT', `/v1/licencias/${EMPRESA}/usuarios-activos`, { token: tokenMiradar, cuerpo: { activos: 3 } });
    assert.equal(rep.datos.puede_crear, false);
    assert.equal((await llamar('PUT', `/v1/licencias/${EMPRESA}/usuarios-activos`, { token: tokenMiradar, cuerpo: { activos: -1 } })).estado, 400);
  });

  test('consumo: aviso al 80 %, tolerancia, bloqueo, idempotencia y anulacion', async () => {
    const consumir = (clave, extra = {}) => llamar('POST', `/v1/licencias/${EMPRESA}/consumos`, { token: tokenMiradar, cuerpo: { clave_idempotente: clave, tipo: 'consulta_reniec', usuario: 'ana', ...extra } });
    for (let i = 1; i <= 7; i += 1) assert.equal((await consumir(`c${i}`)).datos.nivel, 'normal', `consumo ${i}`);
    const octavo = await consumir('c8');
    assert.equal(octavo.datos.nivel, 'aviso');
    assert.equal(octavo.datos.porcentaje, 80);
    await consumir('c9');
    const decimo = await consumir('c10');
    assert.equal(decimo.datos.disponibles, 0);
    const once = await consumir('c11');
    assert.equal(once.datos.permitido, true);
    assert.equal(once.datos.nivel, 'tolerancia');
    const doce = await consumir('c12');
    assert.equal(doce.datos.permitido, false);
    assert.equal(doce.datos.motivo, 'BOLSA_AGOTADA');
    const repetido = await consumir('c5');
    assert.equal(repetido.datos.repetido, true);
    assert.equal(repetido.datos.nivel, 'normal');
    let v = (await llamar('GET', `/v1/licencias/${EMPRESA}`, { token: tokenMiradar })).datos;
    assert.equal(v.tokens.usados, 10, 'repetir una clave no descuenta dos veces');
    assert.equal(v.tokens.tolerancia, 1);
    const anular = await llamar('DELETE', '/v1/consumos/c11', { token: tokenMiradar });
    assert.equal(anular.datos.anulado, true);
    v = (await llamar('GET', `/v1/licencias/${EMPRESA}`, { token: tokenMiradar })).datos;
    assert.equal(v.tokens.tolerancia, 0);
    assert.equal((await llamar('DELETE', '/v1/consumos/c11', { token: tokenGeo })).estado, 404, 'otro producto no puede anular');
    const sulotec = await consumir('s1', { hecho_por_sulotec: true });
    assert.equal(sulotec.datos.permitido, true, 'lo hecho por Sulotec nunca se bloquea');
    assert.equal((await consumir('')).estado, 400);
    const avisos = await pool.query('SELECT tipo FROM avisos WHERE licencia_id = $1 ORDER BY tipo', [licenciaId]);
    assert.deepEqual(avisos.rows.map((f) => f.tipo), ['aviso', 'bloqueo', 'tolerancia']);
  });

  test('mi licencia: solo el titular; pedido de ampliacion', async () => {
    const mia = await llamar('GET', '/v1/mi-licencia', { token: titular });
    assert.equal(mia.estado, 200);
    assert.equal(mia.datos.length, 1);
    assert.equal(mia.datos[0].producto, 'miradar360');
    assert.equal((await llamar('GET', '/v1/mi-licencia', { token: otro })).estado, 403);
    assert.equal((await llamar('GET', `/v1/mi-licencia?empresa=${EMPRESA}`, { token: universal })).datos.length, 1, 'el universal mira cualquier empresa');
    const consumos = await llamar('GET', '/v1/mi-licencia/miradar360/consumos', { token: titular });
    assert.equal(consumos.datos.length, 12);
    const pedido = await llamar('POST', '/v1/mi-licencia/miradar360/ampliar', { token: titular, cuerpo: { que: 'tokens', cantidad: 50, comentario: 'Necesitamos más consultas' } });
    assert.equal(pedido.estado, 201, JSON.stringify(pedido.datos));
    const pendientes = await llamar('GET', '/v1/admin/solicitudes?pendientes=1', { token: universal });
    assert.equal(pendientes.datos.length, 1);
    assert.equal((await llamar('PATCH', `/v1/admin/solicitudes/${pendientes.datos[0].id}`, { token: universal })).estado, 200);
    assert.equal((await llamar('GET', '/v1/admin/solicitudes?pendientes=1', { token: universal })).datos.length, 0);
  });

  test('ampliar, paquete extra, cambiar plan, reporte y bitacora', async () => {
    const amp = await llamar('PATCH', `/v1/admin/licencias/${licenciaId}`, { token: universal, cuerpo: { accion: 'ampliar', tokens_periodo: 20 } });
    assert.equal(amp.estado, 200, JSON.stringify(amp.datos));
    assert.equal(amp.datos.tokens.bolsa, 20, 'la bolsa del mes en curso crece');
    assert.equal(amp.datos.tokens.disponibles, 10, '10 de la bolsa vieja ya usados; lo consumido en tolerancia sigue aparte');
    assert.equal(amp.datos.tokens.tolerancia, 1, 'el consumo de Sulotec en tolerancia queda registrado como tal');
    const extra = await llamar('POST', `/v1/admin/licencias/${licenciaId}/bolsas-extra`, { token: universal, cuerpo: { cantidad: 5 } });
    assert.equal(extra.estado, 201);
    assert.equal(extra.datos.tokens.extra, 5);
    assert.equal(extra.datos.tokens.capacidad, 25);
    const plan2 = await llamar('POST', '/v1/admin/planes', { token: universal, cuerpo: { producto: 'miradar360', nombre: 'Pro', usuarios_max: 10, tokens_periodo: 100 } });
    const cambio = await llamar('PATCH', `/v1/admin/licencias/${licenciaId}`, { token: universal, cuerpo: { accion: 'cambiar_plan', plan_id: plan2.datos.id } });
    assert.equal(cambio.datos.usuarios_max, 10);
    assert.equal(cambio.datos.puede_crear_usuarios, true);
    const rep = await llamar('GET', `/v1/admin/consumos?periodo_desde=${hoy.slice(0, 7)}`, { token: universal });
    assert.equal(rep.datos.resumen.length, 1);
    assert.equal(rep.datos.resumen[0].tokens, 11, '10 normales + 1 de Sulotec; el anulado no cuenta');
    assert.equal(rep.datos.resumen[0].hecho_por_sulotec, 1);
    const excel = await llamar('GET', `/v1/admin/consumos?periodo_desde=${hoy.slice(0, 7)}&formato=xlsx`, { token: universal, crudo: true });
    assert.equal(excel.status, 200);
    assert.match(excel.headers.get('content-type'), /spreadsheetml/);
    assert.ok((await excel.arrayBuffer()).byteLength > 1000);
    const bit = await llamar('GET', `/v1/admin/bitacora?licencia=${licenciaId}`, { token: universal });
    assert.ok(bit.datos.some((b) => b.accion === 'crear_licencia') && bit.datos.some((b) => b.accion === 'cambiar_plan'));
    assert.equal((await llamar('PATCH', '/v1/admin/reglas', { token: universal, cuerpo: { aviso_porcentaje: 90 } })).datos.find((r) => r.clave === 'aviso_porcentaje').valor, 90);
  });

  test('vencimientos: vencida pasa a solo lectura y luego a suspendida', async () => {
    const lic = await llamar('POST', '/v1/admin/licencias', { token: universal, cuerpo: { empresa_uuid: EMPRESA, empresa_nombre: 'Empresa Prueba', producto: 'plaft', usuarios_max: 2, tokens_periodo: 5, inicio: sumar(-40), vencimiento: sumar(-3), titular_email: 'ana@empresa.pe' } });
    assert.equal(lic.estado, 201, JSON.stringify(lic.datos));
    assert.equal(lic.datos.estado, 'SOLO_LECTURA', 'el estado se calcula por fecha aunque la tarea no haya corrido');
    const { aplicarVencimientos } = await import('../src/licencias/servicio.js');
    const r1 = await aplicarVencimientos();
    assert.equal(r1.cambios, 1);
    assert.equal(r1.avisos, 1, 'aviso de vencida para plaft; miradar vence en 30 dias y no avisa');
    const r2 = await aplicarVencimientos();
    assert.equal(r2.cambios, 0);
    assert.equal(r2.avisos, 0, 'repetir la tarea no repite avisos');
    const r3 = await aplicarVencimientos(sumar(10));
    assert.equal(r3.cambios, 1, 'a los 10 dias de vencida queda suspendida');
    const estado = await pool.query('SELECT estado FROM licencias WHERE id = $1', [lic.datos.id]);
    assert.equal(estado.rows[0].estado, 'SUSPENDIDA');
    const renovar = await llamar('PATCH', `/v1/admin/licencias/${lic.datos.id}`, { token: universal, cuerpo: { accion: 'renovar', vencimiento: sumar(365) } });
    assert.equal(renovar.datos.estado, 'ACTIVA');
  });

  test('rotar el token de un producto invalida el anterior', async () => {
    const rot = await llamar('POST', '/v1/admin/productos/geomatrix/token', { token: universal });
    assert.equal(rot.estado, 201);
    assert.match(rot.datos.token, /^geomatrix\./);
    assert.equal((await llamar('GET', `/v1/licencias/${EMPRESA}`, { token: tokenGeo })).estado, 401);
    assert.equal((await llamar('GET', `/v1/licencias/${EMPRESA}`, { token: rot.datos.token })).estado, 404, 'el token nuevo entra (no hay licencia de geomatrix)');
  });
}
