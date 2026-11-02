// Autenticacion de las personas: access token de la cuenta Sulotec (Keycloak), verificado con las claves publicas del realm.
// Claims que se usan: roles (o realm_access.roles), email, preferred_username, name, empresa_uuid, empresa_nombre.
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from '../config.js';

const claves = config.keycloak.jwksLocal
  ? createLocalJWKSet(JSON.parse(config.keycloak.jwksLocal))
  : createRemoteJWKSet(new URL(`${config.keycloak.emisor}/protocol/openid-connect/certs`));

export async function autenticarPersona(req, res, next) {
  const [tipo, token] = (req.get('authorization') || '').split(' ');
  if (tipo !== 'Bearer' || !token) return res.status(401).json({ error: 'SESION_REQUERIDA', mensaje: 'Inicia sesión con tu cuenta Sulotec.' });
  let payload;
  try {
    ({ payload } = await jwtVerify(token, claves, { issuer: config.keycloak.emisor, audience: config.keycloak.audiencia }));
  } catch {
    return res.status(401).json({ error: 'SESION_INVALIDA', mensaje: 'Tu sesión venció o no es válida. Vuelve a iniciar sesión.' });
  }
  const roles = Array.isArray(payload.roles) ? payload.roles : (payload.realm_access?.roles ?? []);
  req.persona = {
    usuario: payload.preferred_username || payload.email || payload.sub,
    email: payload.email || null,
    nombre: payload.name || payload.preferred_username || null,
    roles,
    universal: roles.includes(config.keycloak.rolUniversal),
    empresaUuid: typeof payload.empresa_uuid === 'string' ? payload.empresa_uuid.toLowerCase() : null,
    empresaNombre: payload.empresa_nombre || null,
  };
  next();
}

export const soloUniversal = (req, res, next) => (req.persona?.universal
  ? next()
  : res.status(403).json({ error: 'SOLO_UNIVERSAL', mensaje: 'Solo el Administrador Universal de Sulotec puede hacer esto.' }));
