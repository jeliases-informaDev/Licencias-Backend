// Corre una tarea a mano: node scripts/tarea.js vencimientos [AAAA-MM-DD]
import { migrar, pool } from '../src/bd.js';
import { aplicarVencimientos } from '../src/licencias/servicio.js';

const [tarea, fecha] = process.argv.slice(2);
if (tarea !== 'vencimientos') {
  console.error('Uso: node scripts/tarea.js vencimientos [AAAA-MM-DD]');
  process.exit(1);
}
await migrar();
console.log(await aplicarVencimientos(fecha));
await pool.end();
