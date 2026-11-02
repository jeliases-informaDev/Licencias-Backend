import { readFileSync } from 'node:fs';
import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { consultar } from './bd.js';
import { ErrorApi } from './errores.js';
import { rutasProductos } from './rutas/productos.js';
import { rutasAdmin } from './rutas/admin.js';
import { rutasMiLicencia } from './rutas/mi-licencia.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export function crearApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(cors({ origin: config.corsOrigenes, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allowedHeaders: ['Authorization', 'Content-Type'], maxAge: 600 }));
  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.get('/health', async (req, res) => {
    try {
      await consultar('SELECT 1');
      res.json({ ok: true, servicio: 'licencias', version });
    } catch {
      res.status(503).json({ ok: false, servicio: 'licencias', version, bd: 'sin conexión' });
    }
  });

  app.use('/v1/admin', rutasAdmin);
  app.use('/v1/mi-licencia', rutasMiLicencia);
  app.use('/v1', rutasProductos);

  app.use((req, res) => res.status(404).json({ error: 'NO_ENCONTRADO', mensaje: 'Ruta no encontrada.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ErrorApi) return res.status(err.estado).json({ error: err.codigo, mensaje: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON_INVALIDO', mensaje: 'El cuerpo de la petición no es JSON válido.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'CUERPO_MUY_GRANDE', mensaje: 'El cuerpo de la petición es demasiado grande.' });
    console.error(`${req.method} ${req.originalUrl}:`, err);
    return res.status(500).json({ error: 'ERROR_INTERNO', mensaje: 'Error interno del servicio de licencias.' });
  });
  return app;
}
