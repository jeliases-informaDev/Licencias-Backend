// Cuenta Sulotec de una persona de una empresa: el titular de una licencia (Administrador General) o cualquier usuario que
// el titular agregue desde un producto (todos entran con cuenta Sulotec; ninguna contrasena vive en el producto). Crea la
// cuenta en Keycloak, la une al grupo de su empresa y la invita por correo, igual que apps/cuenta/cuentas.sh (que esto
// reemplaza). Nunca lanza: devuelve un estado y un mensaje listo para mostrar, para no tumbar lo que la llamo.
// La clave temporal (solo si Keycloak no puede mandar el correo) se devuelve una vez: no se guarda ni se escribe en el log.
import { randomBytes } from 'node:crypto';
import { esCorreo } from '../validar.js';
import { configurado, llamar, atributo, grupoEmpresas, hijosDe } from './empresas.js';

const ACCIONES = ['UPDATE_PASSWORD', 'VERIFY_EMAIL'];
const INVITACION = `client_id=portal&redirect_uri=${encodeURIComponent('https://sulotec.com/mis-productos')}&lifespan=604800`;
const UNIVERSALES = ['Administradores Universales', 'Administradores Generales']; // el segundo es el nombre anterior al 2026-11-02

// 120 bits al azar; el prefijo y el final cubren una politica de claves con mayusculas, minusculas, numeros y simbolos.
const claveTemporal = () => `Sulotec-${randomBytes(15).toString('base64url')}#a1A`;

function partirNombre(nombre, correo) {
  const palabras = (nombre || '').trim().split(/\s+/).filter(Boolean);
  if (!palabras.length) return { firstName: correo.split('@')[0], lastName: '' };
  return { firstName: palabras[0], lastName: palabras.slice(1).join(' ') };
}

async function buscarCuenta(correo) {
  const lista = (await llamar(`/users?email=${encodeURIComponent(correo)}&exact=true`)) || [];
  return lista.find((u) => (u.email || '').toLowerCase() === correo) || null;
}

// Invita por correo (con el portal como destino; si Keycloak rechaza el cliente, sin el, como el script). Si Keycloak no
// puede mandar el correo, deja una clave temporal que se cambia al entrar. Un Keycloak que no responde sigue como error.
async function invitar(id) {
  for (const consulta of [INVITACION, 'lifespan=604800']) {
    try {
      await llamar(`/users/${id}/execute-actions-email?${consulta}`, { metodo: 'PUT', cuerpo: ACCIONES });
      return { invitacion: 'correo' };
    } catch (e) {
      if (e.codigo !== 'KEYCLOAK_ERROR') throw e;
    }
  }
  const clave = claveTemporal();
  await llamar(`/users/${id}/reset-password`, { metodo: 'PUT', cuerpo: { type: 'password', value: clave, temporary: true } });
  // Sin correo de salida no puede verificar el correo al entrar: queda solo el cambio de clave (lo mismo que deja cuentas.sh).
  await llamar(`/users/${id}`, { metodo: 'PUT', cuerpo: { requiredActions: ['UPDATE_PASSWORD'] } });
  return { invitacion: 'clave_temporal', clave_temporal: clave };
}

const textoInvitacion = (inv, correo) => (inv.invitacion === 'correo'
  ? `Se envió a ${correo} la invitación para crear su contraseña (vale 7 días).`
  : 'Keycloak no pudo enviar el correo: entrega la clave temporal por un canal seguro (se muestra una sola vez y se cambia al entrar).');

export async function asegurarCuenta({ correo, nombre, empresaUuid, reinvitar = false }) {
  if (!configurado()) return { estado: 'sin_keycloak', invitacion: 'ninguna', mensaje: 'El servicio de licencias no tiene su cliente de Keycloak: la cuenta no se creó. Avisa a Sulotec.' };
  if (!correo || !esCorreo(correo)) return { estado: 'sin_titular', invitacion: 'ninguna', mensaje: 'No hay un correo válido: no se creó ninguna cuenta.' };
  correo = correo.trim().toLowerCase();
  try {
    const pid = await grupoEmpresas();
    const hijos = await hijosDe(pid);
    const grupo = hijos.find((h) => (atributo(h, 'empresa_uuid') || '').toLowerCase() === String(empresaUuid).toLowerCase());
    if (!grupo) return { estado: 'sin_empresa', invitacion: 'ninguna', mensaje: 'La empresa de esta licencia no existe en la cuenta Sulotec (grupo «Empresas»): créala o revisa el UUID; la cuenta no se creó.' };

    let cuenta = await buscarCuenta(correo);
    if (!cuenta) {
      const creada = await llamar('/users', { metodo: 'POST', cuerpo: { username: correo, email: correo, ...partirNombre(nombre, correo), enabled: true, requiredActions: ACCIONES } });
      const id = creada?.ubicacion?.split('/').pop() || (await buscarCuenta(correo))?.id;
      if (!id) return { estado: 'error', invitacion: 'ninguna', mensaje: 'Keycloak no devolvió la cuenta recién creada: revisa en la cuenta Sulotec y usa «Invitar de nuevo».' };
      await llamar(`/users/${id}/groups/${grupo.id}`, { metodo: 'PUT' });
      const inv = await invitar(id);
      return { estado: 'creada', ...inv, mensaje: `Se creó la cuenta Sulotec de ${correo} en la empresa. ${textoInvitacion(inv, correo)}` };
    }

    const grupos = (await llamar(`/users/${cuenta.id}/groups`)) || [];
    const ids = new Set(hijos.map((h) => h.id));
    const otra = grupos.find((g) => g.id !== grupo.id && (ids.has(g.id) || (g.path || '').startsWith('/Empresas/')));
    if (otra) return { estado: 'otra_empresa', invitacion: 'ninguna', mensaje: `La cuenta ${correo} ya pertenece a otra empresa (${otra.name}); cada persona es de una sola empresa. No se cambió nada: usa otro correo o muévela a mano en la cuenta Sulotec.` };
    const universal = grupos.some((g) => UNIVERSALES.includes(g.name));
    if (!universal && !grupos.some((g) => g.id === grupo.id)) await llamar(`/users/${cuenta.id}/groups/${grupo.id}`, { metodo: 'PUT' });

    const pendiente = (cuenta.requiredActions || []).includes('UPDATE_PASSWORD');
    if (reinvitar && pendiente) {
      const inv = await invitar(cuenta.id);
      return { estado: 'existente', ...inv, mensaje: `La cuenta ${correo} ya existía pero nunca se terminó de configurar. ${textoInvitacion(inv, correo)}` };
    }
    return {
      estado: 'existente',
      invitacion: 'ninguna',
      mensaje: pendiente
        ? `La cuenta ${correo} ya existía y todavía no crea su contraseña: usa «Invitar de nuevo» para reenviarle la invitación.`
        : `La cuenta ${correo} ya está activa: entra con su contraseña de siempre (si la olvidó, puede usar «¿Olvidaste tu contraseña?»).`,
    };
  } catch (e) {
    console.error(`Keycloak: no se pudo asegurar una cuenta de la empresa ${empresaUuid}: ${e.message}`);
    return { estado: 'error', invitacion: 'ninguna', mensaje: `No se pudo crear o invitar la cuenta en Keycloak (${e.message}). No se perdió nada: vuelve a intentarlo («Invitar de nuevo») cuando Keycloak responda.` };
  }
}
export const asegurarCuentaTitular = asegurarCuenta; // nombre anterior
