// Genera (o rota) el token con el que un producto habla con el servicio. Se muestra UNA sola vez; la base guarda solo su hash.
//   node scripts/token-producto.js geomatrix
// En el servidor: sudo docker exec licencias node scripts/token-producto.js geomatrix
import { migrar, consultar, pool } from '../src/bd.js';
import { generarToken, hashToken } from '../src/auth/productos.js';

const clave = process.argv[2];
if (!clave) {
  console.error('Uso: node scripts/token-producto.js <geomatrix|miradar360|plaft|buscador|dashboard|indira>');
  process.exit(1);
}
await migrar();
const token = generarToken(clave);
const r = await consultar('UPDATE productos SET token_hash = $2, token_rotado_en = now() WHERE clave = $1', [clave, hashToken(token)]);
if (!r.rowCount) {
  console.error(`No existe el producto ${clave}`);
  process.exit(1);
}
console.log(`LICENCIAS_TOKEN=${token}`);
await pool.end();
