// Configuracion por variables de entorno (en el servidor: /opt/sulotec/licencias.env). Ver .env.ejemplo.
const env = (clave, porDefecto) => {
  const v = process.env[clave];
  return v === undefined || v === '' ? porDefecto : v;
};
const requerido = (clave) => {
  const v = env(clave);
  if (v === undefined) throw new Error(`Falta la variable de entorno ${clave}`);
  return v;
};

export const config = {
  puerto: Number(env('PORT', 3200)),
  bdUrl: requerido('DATABASE_URL'),
  keycloak: {
    emisor: env('KEYCLOAK_ISSUER', 'https://cuenta.sulotec.com/realms/sulotec'),
    audiencia: env('KEYCLOAK_AUDIENCE', 'licencias'),
    rolUniversal: env('ROL_UNIVERSAL', 'administrador-general'),
    jwksLocal: env('KEYCLOAK_JWKS_LOCAL'), // solo para pruebas: JWKS en JSON en vez del de cuenta.sulotec.com
  },
  corsOrigenes: env('CORS_ORIGENES', 'https://sulotec.com').split(',').map((s) => s.trim()).filter(Boolean),
  portalUrl: env('PORTAL_URL', 'https://sulotec.com'),
  correo: {
    host: env('SMTP_HOST'),
    puerto: Number(env('SMTP_PORT', 587)),
    usuario: env('SMTP_USER'),
    clave: env('SMTP_PASS'),
    remitente: env('CORREO_REMITENTE', 'Sulotec <no-reply@sulotec.com>'),
    contacto: env('CORREO_CONTACTO', 'contacto@sulotec.com'),
  },
  zonaHoraria: env('ZONA_HORARIA', 'America/Lima'),
  tareas: env('TAREAS', '1') !== '0',
};
