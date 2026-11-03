// Autenticacion de los productos (servidor a servidor): un token por producto, con la forma <clave>.<secreto>.
// La base guarda solo el hash; el token se muestra una sola vez al generarlo (scripts/token-producto.js o /v1/admin/productos/:clave/token).
import { createHash, randomBytes } from 'node:crypto';
import { consultar } from '../bd.js';

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');
export const generarToken = (clave) => `${clave}.${randomBytes(24).toString('base64url')}`;

export async function autenticarProducto(req, res, next) {
  const [tipo, token] = (req.get('authorization') || '').split(' ');
  if (tipo !== 'Bearer' || !token) return res.status(401).json({ error: 'TOKEN_REQUERIDO', mensaje: 'Falta el token del producto (Authorization: Bearer).' });
  const clave = token.split('.')[0];
  const { rows } = await consultar('SELECT clave, nombre, usa_tokens FROM productos WHERE clave = $1 AND token_hash = $2', [clave, hashToken(token)]);
  if (!rows[0]) return res.status(401).json({ error: 'TOKEN_INVALIDO', mensaje: 'El token del producto no es válido o fue rotado.' });
  req.producto = rows[0];
  next();
}
