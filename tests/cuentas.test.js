// Cuenta del titular en Keycloak, contra un Keycloak de mentira (servidor http local) que imita las rutas que usa el servicio.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const EMPRESA = '11111111-1111-4111-8111-111111111111';
let servidor; let asegurar; let usuarios; let pertenencias; let correoFalla; let caido; let llamadas;
const leerJson = (req) => new Promise((res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => res(d ? JSON.parse(d) : null)); });
const grupos = [
  { id: 'g1', name: 'caja-huancayo', path: '/Empresas/caja-huancayo', attributes: { empresa_uuid: [EMPRESA] } },
  { id: 'g2', name: 'caja-piura', path: '/Empresas/caja-piura', attributes: { empresa_uuid: ['22222222-2222-4222-8222-222222222222'] } },
];
const ADMINS = { id: 'gadm', name: 'Administradores Universales', path: '/Administradores Universales' };

before(async () => {
  servidor = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (codigo, datos) => { res.writeHead(codigo, { 'content-type': 'application/json' }); res.end(datos === undefined ? '' : JSON.stringify(datos)); };
    if (caido) return json(500, { error: 'caido' });
    if (url.pathname === '/realms/sulotec/protocol/openid-connect/token') return json(200, { access_token: 'tok', expires_in: 60 });
    if (req.headers.authorization !== 'Bearer tok') return json(401, { error: 'sin token' });
    const p = url.pathname.replace('/admin/realms/sulotec', '');
    llamadas.push(`${req.method} ${p}`);
    if (p === '/groups') return json(200, [{ id: 'padre', name: 'Empresas' }]);
    if (p === '/groups/padre/children') return json(200, grupos);
    if (p === '/users' && req.method === 'GET') return json(200, usuarios.filter((u) => u.email === url.searchParams.get('email')));
    if (p === '/users' && req.method === 'POST') {
      const u = await leerJson(req); const id = `u${usuarios.length + 1}`; usuarios.push({ id, ...u }); pertenencias[id] = [];
      res.writeHead(201, { location: `http://x/admin/realms/sulotec/users/${id}` }); return res.end();
    }
    let m = p.match(/^\/users\/(u\d+)\/groups$/);
    if (m) return json(200, (pertenencias[m[1]] || []).map((gid) => [...grupos, ADMINS].find((g) => g.id === gid)));
    m = p.match(/^\/users\/(u\d+)\/groups\/(\w+)$/);
    if (m && req.method === 'PUT') { pertenencias[m[1]].push(m[2]); return json(204); }
    m = p.match(/^\/users\/(u\d+)\/execute-actions-email$/);
    if (m) return correoFalla ? json(500, { errorMessage: 'Failed to send execute actions email' }) : json(204);
    m = p.match(/^\/users\/(u\d+)\/reset-password$/);
    if (m) { const b = await leerJson(req); usuarios.find((u) => u.id === m[1]).clave = b; return json(204); }
    m = p.match(/^\/users\/(u\d+)$/);
    if (m && req.method === 'PUT') { const b = await leerJson(req); Object.assign(usuarios.find((u) => u.id === m[1]), b); return json(204); }
    return json(404, { error: `ruta desconocida en la prueba: ${req.method} ${p}` });
  }).listen(0);
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://x:x@127.0.0.1:1/x';
  process.env.KEYCLOAK_INTERNO = `http://127.0.0.1:${servidor.address().port}`;
  process.env.KEYCLOAK_CLIENT_SECRET = 'secreto-de-prueba';
  ({ asegurarCuentaTitular: asegurar } = await import('../src/keycloak/cuentas.js'));
});
after(() => servidor.close());
beforeEach(() => {
  usuarios = []; pertenencias = {}; correoFalla = false; caido = false; llamadas = [];
});

test('crea la cuenta del titular, la une a su empresa y la invita por correo', async () => {
  const r = await asegurar({ correo: 'Ana.Perez@ejemplo.com', nombre: 'Ana María Pérez', empresaUuid: EMPRESA });
  assert.equal(r.estado, 'creada');
  assert.equal(r.invitacion, 'correo');
  assert.equal(r.clave_temporal, undefined);
  assert.deepEqual(usuarios[0], { id: 'u1', username: 'ana.perez@ejemplo.com', email: 'ana.perez@ejemplo.com', firstName: 'Ana', lastName: 'María Pérez', enabled: true, requiredActions: ['UPDATE_PASSWORD', 'VERIFY_EMAIL'] });
  assert.deepEqual(pertenencias.u1, ['g1']);
  assert.ok(llamadas.some((l) => l === 'PUT /users/u1/execute-actions-email'));
  const sinNombre = await asegurar({ correo: 'luis@ejemplo.com', empresaUuid: EMPRESA });
  assert.equal(sinNombre.estado, 'creada');
  assert.equal(usuarios[1].firstName, 'luis', 'sin nombre usa la parte local del correo');
});

test('cuenta existente de la misma empresa: no toca nada; reinvita solo si nunca se configuro', async () => {
  usuarios.push({ id: 'u1', email: 'ana@ejemplo.com', requiredActions: ['UPDATE_PASSWORD'] }); pertenencias.u1 = ['g1'];
  const r = await asegurar({ correo: 'ana@ejemplo.com', empresaUuid: EMPRESA });
  assert.equal(r.estado, 'existente');
  assert.equal(r.invitacion, 'ninguna');
  assert.deepEqual(pertenencias.u1, ['g1']);
  const re = await asegurar({ correo: 'ana@ejemplo.com', empresaUuid: EMPRESA, reinvitar: true });
  assert.equal(re.invitacion, 'correo', 'pendiente de configurar: se reinvita');
  usuarios[0].requiredActions = [];
  const activa = await asegurar({ correo: 'ana@ejemplo.com', empresaUuid: EMPRESA, reinvitar: true });
  assert.equal(activa.invitacion, 'ninguna', 'ya configurada: no se reinvita');
  assert.match(activa.mensaje, /Olvidaste tu contraseña/);
});

test('cuenta existente sin empresa se une a esta; la universal no cambia de grupos', async () => {
  usuarios.push({ id: 'u1', email: 'sola@ejemplo.com' }, { id: 'u2', email: 'uni@ejemplo.com' }); pertenencias.u1 = []; pertenencias.u2 = ['gadm'];
  assert.equal((await asegurar({ correo: 'sola@ejemplo.com', empresaUuid: EMPRESA })).estado, 'existente');
  assert.deepEqual(pertenencias.u1, ['g1']);
  assert.equal((await asegurar({ correo: 'uni@ejemplo.com', empresaUuid: EMPRESA })).estado, 'existente');
  assert.deepEqual(pertenencias.u2, ['gadm']);
});

test('cuenta de otra empresa: no se mueve', async () => {
  usuarios.push({ id: 'u1', email: 'piura@ejemplo.com' }); pertenencias.u1 = ['g2'];
  const r = await asegurar({ correo: 'piura@ejemplo.com', empresaUuid: EMPRESA, reinvitar: true });
  assert.equal(r.estado, 'otra_empresa');
  assert.equal(r.invitacion, 'ninguna');
  assert.deepEqual(pertenencias.u1, ['g2']);
  assert.ok(!llamadas.some((l) => l.startsWith('PUT')), 'no toca nada');
});

test('sin grupo de la empresa o sin correo del titular', async () => {
  const r = await asegurar({ correo: 'ana@ejemplo.com', empresaUuid: '99999999-9999-4999-8999-999999999999' });
  assert.equal(r.estado, 'sin_empresa');
  assert.equal(usuarios.length, 0);
  assert.equal((await asegurar({ correo: null, empresaUuid: EMPRESA })).estado, 'sin_titular');
});

test('si Keycloak no puede mandar el correo, deja una clave temporal que se cambia al entrar', async () => {
  correoFalla = true;
  const r = await asegurar({ correo: 'ana@ejemplo.com', nombre: 'Ana', empresaUuid: EMPRESA });
  assert.equal(r.estado, 'creada');
  assert.equal(r.invitacion, 'clave_temporal');
  assert.ok(r.clave_temporal.length >= 28);
  assert.deepEqual(usuarios[0].clave, { type: 'password', value: r.clave_temporal, temporary: true });
  assert.deepEqual(usuarios[0].requiredActions, ['UPDATE_PASSWORD']);
  assert.ok(!r.mensaje.includes(r.clave_temporal), 'la clave no va en el mensaje');
  assert.equal(llamadas.filter((l) => l.endsWith('execute-actions-email')).length, 2, 'prueba con y sin el cliente del portal, como cuentas.sh');
});

test('Keycloak caido: estado error, no lanza', async () => {
  caido = true;
  const r = await asegurar({ correo: 'ana@ejemplo.com', empresaUuid: EMPRESA });
  assert.equal(r.estado, 'error');
  assert.equal(r.invitacion, 'ninguna');
  assert.match(r.mensaje, /No se perdió nada/);
});
