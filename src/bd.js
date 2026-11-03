import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { config } from './config.js';

// Las fechas (date) llegan como texto AAAA-MM-DD, nunca como Date: evita corrimientos por zona horaria.
pg.types.setTypeParser(1082, (v) => v);

const { Pool } = pg;
export const pool = new Pool({ connectionString: config.bdUrl, max: 10 });
pool.on('error', (e) => console.error('PostgreSQL:', e.message));

export const consultar = (texto, params) => pool.query(texto, params);

export async function transaccion(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// Aplica bd/esquema.sql (idempotente). Se corre en cada arranque.
export async function migrar() {
  const sql = await readFile(new URL('../bd/esquema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}
