// Crea una licencia DE PRUEBA en una base local y genera el token del producto, para que el responsable de un producto
// pruebe su cliente contra el servicio corriendo en su PC, sin Keycloak ni portal.
// Guia completa: Sulotec-infra/docs/licencias/INTEGRACION-PRODUCTOS.md (seccion 6).
//
//   node --env-file=.env scripts/licencia-prueba.js plaft --tokens 20 --usuarios 2
//   node --env-file=.env scripts/licencia-prueba.js geomatrix --usuarios 3 --empresa 11111111-1111-4111-8111-111111111111 --nombre "Caja de prueba"
//
// Opciones: --empresa <uuid> (si no se da, se inventa uno) · --nombre "..." · --usuarios (3) · --tokens (20; en productos sin tokens es 0)
//           --titular <correo> · --sin-token (no genera ni rota el token del producto) · --forzar (permite una base que no sea local)
// Se niega a correr contra una base que no sea local (localhost / 127.0.0.1): en produccion las licencias se crean en sulotec.com/licencias.
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const producto = args[0];
const opcion = (nombre, porDefecto) => {
  const i = args.indexOf(`--${nombre}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : porDefecto;
};
const bandera = (nombre) => args.includes(`--${nombre}`);

if (!producto || producto.startsWith('--')) {
  console.error('Uso: node --env-file=.env scripts/licencia-prueba.js <geomatrix|miradar360|plaft|buscador|dashboard> [--tokens 20] [--usuarios 3] [--empresa <uuid>] [--nombre "..."] [--titular correo] [--sin-token] [--forzar]');
  process.exit(1);
}

const host = (() => { try { return new URL(process.env.DATABASE_URL || '').hostname; } catch { return ''; } })();
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host) && !bandera('forzar')) {
  console.error(`La base (${host || 'sin DATABASE_URL'}) no es local. Este script es solo para pruebas: en producción las licencias se crean en sulotec.com/licencias. Si de verdad quieres, agrega --forzar.`);
  process.exit(1);
}

// Se importan después de la comprobación para que un .env incompleto dé un mensaje claro y no una traza.
const { migrar, consultar, pool } = await import('../src/bd.js');
const { generarToken, hashToken } = await import('../src/auth/productos.js');
const { crearLicencia } = await import('../src/licencias/servicio.js');

try {
  await migrar();
  const pr = (await consultar('SELECT clave, nombre, usa_tokens FROM productos WHERE clave = $1', [producto])).rows[0];
  if (!pr) throw new Error(`No existe el producto «${producto}». Productos: geomatrix, miradar360, plaft, buscador, dashboard.`);

  const empresa = opcion('empresa', randomUUID()).toLowerCase();
  const titular = opcion('titular', null);
  const licencia = await crearLicencia({
    empresa_uuid: empresa,
    empresa_nombre: opcion('nombre', `Empresa de pruebas ${pr.nombre}`),
    producto,
    usuarios_max: Number(opcion('usuarios', 3)),
    tokens_periodo: pr.usa_tokens ? Number(opcion('tokens', 20)) : 0,
    titular_email: titular,
    titular_nombre: titular ? 'Titular de pruebas' : null,
  }, 'licencia-prueba');
  console.log(JSON.stringify(licencia, null, 2));

  const puerto = process.env.PORT || 3200;
  console.log('\n# Variables para el producto (apuntando a tu servicio local):');
  console.log(`LICENCIAS_URL=http://localhost:${puerto}`);
  console.log(`LICENCIAS_PRODUCTO=${producto}`);
  if (!bandera('sin-token')) {
    const token = generarToken(producto);
    await consultar('UPDATE productos SET token_hash = $2, token_rotado_en = now() WHERE clave = $1', [producto, hashToken(token)]);
    console.log(`LICENCIAS_TOKEN=${token}`);
    console.log('\n# Prueba rápida:');
    console.log(`curl -s -H "Authorization: Bearer ${token}" http://localhost:${puerto}/v1/licencias/${empresa}`);
    if (pr.usa_tokens) {
      console.log(`curl -s -X POST -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d '{"clave_idempotente":"${producto}:${empresa}:prueba:1","tipo":"prueba","cantidad":1}' http://localhost:${puerto}/v1/licencias/${empresa}/consumos`);
    }
  }
} catch (e) {
  console.error(e.codigo ? `${e.codigo}: ${e.message}` : e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
