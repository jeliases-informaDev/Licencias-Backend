// Empresas en la cuenta Sulotec (Keycloak): cada empresa es un subgrupo de "Empresas" con los atributos empresa_uuid,
// empresa_nombre y empresa_slug, y con los roles producto-* de lo que tiene contratado (igual que apps/cuenta/empresa.sh).
// El servicio entra con su propio cliente (cuenta de servicio "licencias") por la direccion interna de la VM, porque
// /admin de cuenta.sulotec.com esta detras de Cloudflare Access.
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { ErrorApi } from '../errores.js';
import { exigir, texto } from '../validar.js';

const k = config.keycloak;
const realm = k.emisor.split('/realms/')[1];
const base = (k.interno || k.emisor.split('/realms/')[0]).replace(/\/$/, '');
const admin = `${base}/admin/realms/${realm}`;

// Clave del producto en este servicio -> rol producto-* de Keycloak (GeoMatrix conserva el nombre tecnico "auditoria";
// el Buscador no tiene rol: es interno y entra por Cloudflare Access).
export const ROL_PRODUCTO = { geomatrix: 'producto-auditoria', miradar360: 'producto-miradar360', plaft: 'producto-plaft', dashboard: 'producto-dashboard' };
export const esSlug = (v) => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{1,38}$/.test(v);
export const configurado = () => Boolean(k.clienteSecreto);

// Estado para los fallos de Keycloak. No se usa 502 ni 504: Cloudflare reemplaza esas respuestas del origen por su propia página (sin
// cabeceras CORS) y el portal solo podría decir «no responde». 424 = falló algo de lo que dependemos; el mensaje llega tal cual.
const FALLO_KEYCLOAK = 424;
const ESPERA_MS = 8000;
const anotar = (texto) => console.error(`Keycloak: ${texto}`);

let cacheToken = { valor: null, hasta: 0 };
async function token() {
  if (!configurado()) throw new ErrorApi(503, 'KEYCLOAK_NO_CONFIGURADO', 'El servicio no tiene su cliente de Keycloak (KEYCLOAK_CLIENT_SECRET): corre preparar.sh del kit.');
  if (cacheToken.valor && cacheToken.hasta > Date.now()) return cacheToken.valor;
  let r;
  try {
    r = await fetch(`${base}/realms/${realm}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: k.clienteId, client_secret: k.clienteSecreto }),
      signal: AbortSignal.timeout(ESPERA_MS),
    });
  } catch (e) {
    anotar(`sin respuesta al pedir el token en ${base}: ${e.message}`);
    throw new ErrorApi(FALLO_KEYCLOAK, 'KEYCLOAK_SIN_ACCESO', `No se pudo hablar con Keycloak en ${base}: ${e.message}`);
  }
  if (!r.ok) anotar(`el token del cliente «${k.clienteId}» fue rechazado (${r.status})`);
  if (!r.ok) throw new ErrorApi(FALLO_KEYCLOAK, 'KEYCLOAK_SIN_ACCESO', `Keycloak no aceptó al servicio (${r.status}): revisa el cliente «licencias» (ajustar-realm.sh) y su clave (preparar.sh).`);
  const t = await r.json();
  cacheToken = { valor: t.access_token, hasta: Date.now() + Math.max(10, (t.expires_in || 60) - 10) * 1000 };
  return t.access_token;
}

async function llamar(ruta, { metodo = 'GET', cuerpo } = {}) {
  const credencial = await token();
  let r;
  try {
    r = await fetch(`${admin}${ruta}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${credencial}`, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      signal: AbortSignal.timeout(ESPERA_MS),
    });
  } catch (e) {
    anotar(`sin respuesta en ${metodo} ${ruta}: ${e.message}`);
    throw new ErrorApi(FALLO_KEYCLOAK, 'KEYCLOAK_SIN_ACCESO', `Keycloak no respondió a tiempo (${metodo} ${ruta}): ${e.message}`);
  }
  if (r.status === 404 && metodo === 'GET') return null;
  if (!r.ok) {
    const detalle = await r.text().catch(() => '');
    anotar(`respondió ${r.status} en ${metodo} ${ruta}${detalle ? `: ${detalle.slice(0, 200)}` : ''}`);
    throw new ErrorApi(FALLO_KEYCLOAK, 'KEYCLOAK_ERROR', `Keycloak respondió ${r.status} en ${metodo} ${ruta}${detalle ? `: ${detalle.slice(0, 200)}` : ''}`);
  }
  if (r.status === 201 || r.status === 204) return { ubicacion: r.headers.get('location') };
  return r.json();
}

const atributo = (g, nombre) => g.attributes?.[nombre]?.[0] ?? null;

async function grupoEmpresas() {
  const grupos = (await llamar('/groups?search=Empresas&exact=true')) || [];
  const g = grupos.find((x) => x.name === 'Empresas');
  if (!g) throw new ErrorApi(FALLO_KEYCLOAK, 'KEYCLOAK_SIN_EMPRESAS', 'No existe el grupo «Empresas» en Keycloak: corre ajustar-realm.sh.');
  return g.id;
}
const hijosDe = async (pid) => (await llamar(`/groups/${pid}/children?first=0&max=500&briefRepresentation=false`)) || [];

export async function listarEmpresas() {
  const hijos = await hijosDe(await grupoEmpresas());
  const lista = [];
  for (const h of hijos) {
    const uuid = atributo(h, 'empresa_uuid');
    if (!uuid) continue;
    const roles = (await llamar(`/groups/${h.id}/role-mappings/realm`)) || [];
    const productos = roles.map((r) => r.name).filter((n) => n.startsWith('producto-')).map((n) => n.slice('producto-'.length));
    lista.push({ uuid: uuid.toLowerCase(), nombre: atributo(h, 'empresa_nombre') || h.name, slug: atributo(h, 'empresa_slug') || h.name, productos });
  }
  return lista.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

async function grupoDe(uuid) {
  const hijos = await hijosDe(await grupoEmpresas());
  return hijos.find((h) => (atributo(h, 'empresa_uuid') || '').toLowerCase() === uuid.toLowerCase()) || null;
}

// Da a la empresa el rol producto-* del producto (sus personas entran por inicio unico). Devuelve false si no aplica.
export async function darProducto(uuid, producto, gid) {
  const rol = ROL_PRODUCTO[producto];
  if (!rol) return false;
  const g = gid ? { id: gid } : await grupoDe(uuid);
  if (!g) return false;
  const r = await llamar(`/roles/${rol}`);
  if (!r) return false;
  await llamar(`/groups/${g.id}/role-mappings/realm`, { metodo: 'POST', cuerpo: [{ id: r.id, name: r.name }] });
  return true;
}

export async function quitarProducto(uuid, producto) {
  const rol = ROL_PRODUCTO[producto];
  if (!rol) return false;
  const g = await grupoDe(uuid);
  if (!g) return false;
  const r = await llamar(`/roles/${rol}`);
  if (!r) return false;
  await llamar(`/groups/${g.id}/role-mappings/realm`, { metodo: 'DELETE', cuerpo: [{ id: r.id, name: r.name }] });
  return true;
}

export async function crearEmpresa({ nombre, slug, productos = [] }) {
  exigir(texto(nombre, 120), 'nombre de la empresa es obligatorio (hasta 120 caracteres).');
  exigir(esSlug(slug), 'identificador corto: solo minúsculas, números y guion, de 2 a 39 caracteres (por ejemplo caja-piura).');
  exigir(Array.isArray(productos) && productos.every((p) => ROL_PRODUCTO[p]), `productos: lista con ${Object.keys(ROL_PRODUCTO).join(', ')}.`);
  const pid = await grupoEmpresas();
  const repetida = (await hijosDe(pid)).find((h) => h.name === slug || atributo(h, 'empresa_slug') === slug);
  if (repetida) throw new ErrorApi(409, 'EMPRESA_EXISTE', `Ya existe una empresa con el identificador «${slug}» (${atributo(repetida, 'empresa_nombre') || repetida.name}). Elígela en la lista.`);
  const uuid = randomUUID();
  await llamar(`/groups/${pid}/children`, { metodo: 'POST', cuerpo: { name: slug, attributes: { empresa_uuid: [uuid], empresa_nombre: [nombre.trim()], empresa_slug: [slug] } } });
  const g = (await hijosDe(pid)).find((h) => h.name === slug);
  if (!g) throw new ErrorApi(FALLO_KEYCLOAK, 'KEYCLOAK_ERROR', 'Keycloak no devolvió el grupo de la empresa recién creada.');
  for (const p of productos) await darProducto(uuid, p, g.id);
  return { uuid, nombre: nombre.trim(), slug, productos };
}
