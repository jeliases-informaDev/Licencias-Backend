// Empresas en Keycloak, contra un Keycloak de mentira (servidor http local) que imita las rutas que usa el servicio.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

let servidor; let empresas; let grupos; let roles;
const leerJson = (req) => new Promise((res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => res(d ? JSON.parse(d) : null)); });

before(async () => {
  grupos = [{ id: 'g1', name: 'caja-huancayo', attributes: { empresa_uuid: ['11111111-1111-4111-8111-111111111111'], empresa_nombre: ['Caja Huancayo'], empresa_slug: ['caja-huancayo'] } }];
  roles = { g1: [{ id: 'r1', name: 'producto-auditoria' }] };
  servidor = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (codigo, datos) => { res.writeHead(codigo, { 'content-type': 'application/json' }); res.end(datos === undefined ? '' : JSON.stringify(datos)); };
    const auth = req.headers.authorization;
    if (url.pathname === '/realms/sulotec/protocol/openid-connect/token') return json(200, { access_token: 'tok', expires_in: 60 });
    if (auth !== 'Bearer tok') return json(401, { error: 'sin token' });
    if (url.pathname === '/admin/realms/sulotec/groups') return json(200, [{ id: 'padre', name: 'Empresas' }]);
    if (url.pathname === '/admin/realms/sulotec/groups/padre/children' && req.method === 'GET') return json(200, grupos);
    if (url.pathname === '/admin/realms/sulotec/groups/padre/children' && req.method === 'POST') {
      const g = await leerJson(req); grupos.push({ id: `g${grupos.length + 1}`, ...g }); res.writeHead(201, { location: `http://x/admin/realms/sulotec/groups/g${grupos.length}` }); return res.end();
    }
    const m = url.pathname.match(/^\/admin\/realms\/sulotec\/groups\/(g\d+)\/role-mappings\/realm$/);
    if (m && req.method === 'GET') return json(200, roles[m[1]] || []);
    if (m && req.method === 'POST') { const r = await leerJson(req); roles[m[1]] = [...(roles[m[1]] || []), ...r]; return json(204); }
    if (m && req.method === 'DELETE') { const r = await leerJson(req); roles[m[1]] = (roles[m[1]] || []).filter((x) => !r.some((y) => y.name === x.name)); return json(204); }
    const rol = url.pathname.match(/^\/admin\/realms\/sulotec\/roles\/(producto-[a-z0-9]+)$/);
    if (rol) return json(200, { id: `id-${rol[1]}`, name: rol[1] });
    return json(404, { error: 'ruta desconocida en la prueba: ' + req.method + ' ' + url.pathname });
  }).listen(0);
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://x:x@127.0.0.1:1/x';
  process.env.KEYCLOAK_INTERNO = `http://127.0.0.1:${servidor.address().port}`;
  process.env.KEYCLOAK_CLIENT_SECRET = 'secreto-de-prueba';
  empresas = await import('../src/keycloak/empresas.js');
});
after(() => servidor.close());

test('lista las empresas con su uuid, nombre, slug y productos', async () => {
  const lista = await empresas.listarEmpresas();
  assert.equal(lista.length, 1);
  assert.deepEqual(lista[0], { uuid: '11111111-1111-4111-8111-111111111111', nombre: 'Caja Huancayo', slug: 'caja-huancayo', productos: ['auditoria'] });
});

test('crea una empresa nueva con uuid propio y le da el rol del producto', async () => {
  const e = await empresas.crearEmpresa({ nombre: 'Caja Piura', slug: 'caja-piura', productos: ['geomatrix'] });
  assert.match(e.uuid, /^[0-9a-f-]{36}$/);
  assert.equal(grupos.at(-1).name, 'caja-piura');
  assert.deepEqual(grupos.at(-1).attributes.empresa_uuid, [e.uuid]);
  assert.deepEqual(roles.g2.map((r) => r.name), ['producto-auditoria']);
  await assert.rejects(empresas.crearEmpresa({ nombre: 'Otra', slug: 'caja-piura', productos: [] }), (err) => err.codigo === 'EMPRESA_EXISTE');
  await assert.rejects(empresas.crearEmpresa({ nombre: 'Mal', slug: 'Caja Piura', productos: [] }), (err) => err.codigo === 'DATOS_INVALIDOS');
  await assert.rejects(empresas.crearEmpresa({ nombre: 'Mal', slug: 'x', productos: ['buscador'] }), (err) => err.codigo === 'DATOS_INVALIDOS');
});

test('da y quita el rol de un producto a una empresa existente', async () => {
  assert.equal(await empresas.darProducto('11111111-1111-4111-8111-111111111111', 'plaft'), true);
  assert.ok(roles.g1.some((r) => r.name === 'producto-plaft'));
  assert.equal(await empresas.quitarProducto('11111111-1111-4111-8111-111111111111', 'plaft'), true);
  assert.ok(!roles.g1.some((r) => r.name === 'producto-plaft'));
  assert.equal(await empresas.darProducto('11111111-1111-4111-8111-111111111111', 'buscador'), false, 'el buscador no tiene rol');
  assert.equal(await empresas.darProducto('99999999-9999-4999-8999-999999999999', 'plaft'), false, 'empresa que no existe');
});
