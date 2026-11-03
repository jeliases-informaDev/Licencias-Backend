// Correos del servicio (avisos al titular y pedidos a Sulotec). Sin SMTP configurado solo se registran en el log.
import nodemailer from 'nodemailer';
import { config } from '../config.js';

const c = config.correo;
const transporte = c.host
  ? nodemailer.createTransport({ host: c.host, port: c.puerto, secure: c.puerto === 465, auth: c.usuario ? { user: c.usuario, pass: c.clave } : undefined })
  : null;

export async function enviar({ para, asunto, texto }) {
  if (!para) return false;
  if (!transporte) {
    console.log(`[correo no configurado] para ${para}: ${asunto}`);
    return false;
  }
  try {
    await transporte.sendMail({ from: c.remitente, to: para, subject: asunto, text: texto });
    return true;
  } catch (e) {
    console.error(`No se pudo enviar el correo "${asunto}" a ${para}: ${e.message}`);
    return false;
  }
}

const saludo = (l) => `Hola${l.titular_nombre ? ` ${l.titular_nombre}` : ''},\n\n`;
const pie = () => `\n\nPuedes ver el detalle y pedir una ampliación en ${config.portalUrl}/mi-licencia\n\nSulotec`;
const nombre = (l) => l.producto_nombre || l.producto;

export const plantillas = {
  aviso: (l, t, r) => ({
    asunto: `[Sulotec] ${nombre(l)}: ${l.empresa_nombre} usó el ${t.porcentaje} % de su bolsa`,
    texto: `${saludo(l)}${l.empresa_nombre} ya usó ${t.usados} de ${t.capacidad} tokens de ${nombre(l)} en este periodo (${t.porcentaje} %). `
      + `Cuando la bolsa se agote podrás seguir usando una tolerancia del ${r.toleranciaPct} %, que se factura aparte.${pie()}`,
  }),
  tolerancia: (l, t, r) => ({
    asunto: `[Sulotec] ${nombre(l)}: la bolsa de ${l.empresa_nombre} se agotó, estás en la tolerancia`,
    texto: `${saludo(l)}${l.empresa_nombre} agotó sus ${t.capacidad} tokens de ${nombre(l)} de este periodo. Sigue funcionando con la tolerancia del ${r.toleranciaPct} % `
      + `(${t.toleranciaMax} tokens), que se factura aparte. Después de eso las consultas se bloquean hasta ampliar el plan.${pie()}`,
  }),
  bloqueo: (l, t) => ({
    asunto: `[Sulotec] ${nombre(l)}: ${l.empresa_nombre} se quedó sin tokens`,
    texto: `${saludo(l)}${l.empresa_nombre} agotó su bolsa de ${nombre(l)} y también la tolerancia (${t.toleranciaMax} tokens). Las consultas quedan bloqueadas hasta que amplíes el plan o compres un paquete extra.${pie()}`,
  }),
  vence: (l, dias) => ({
    asunto: `[Sulotec] ${nombre(l)}: la licencia de ${l.empresa_nombre} vence ${dias === 0 ? 'hoy' : `en ${dias} día${dias === 1 ? '' : 's'}`}`,
    texto: `${saludo(l)}La licencia de ${nombre(l)} de ${l.empresa_nombre} vence el ${l.vencimiento}. Si no se renueva, el producto pasará a solo lectura y luego se suspenderá; los datos se conservan.${pie()}`,
  }),
  vencida: (l, dias, r) => ({
    asunto: `[Sulotec] ${nombre(l)}: la licencia de ${l.empresa_nombre} venció`,
    texto: `${saludo(l)}La licencia de ${nombre(l)} de ${l.empresa_nombre} venció el ${l.vencimiento}. Durante ${r.soloLecturaDias} días el producto queda en solo lectura (se puede ver, no registrar). Después se suspende.${pie()}`,
  }),
  suspendida: (l) => ({
    asunto: `[Sulotec] ${nombre(l)}: la licencia de ${l.empresa_nombre} quedó suspendida`,
    texto: `${saludo(l)}La licencia de ${nombre(l)} de ${l.empresa_nombre} quedó suspendida por falta de renovación. Los datos se conservan; al renovar, todo vuelve a estar disponible.${pie()}`,
  }),
  licenciaCreada: (v) => ({
    asunto: `[Sulotec] ${v.producto_nombre}: licencia activa para ${v.empresa_nombre}`,
    texto: `${saludo({ titular_nombre: v.titular?.nombre })}Ya está activa la licencia de ${v.producto_nombre} para ${v.empresa_nombre}: hasta ${v.usuarios_max} usuarios`
      + `${v.tokens ? ` y ${v.tokens.bolsa} tokens por periodo` : ''}, vigente hasta el ${v.vencimiento}. Como Administrador General, tú creas y desactivas a tus sub-usuarios dentro del producto.${pie()}`,
  }),
  solicitud: (l, s) => ({
    asunto: `[Licencias] ${l.empresa_nombre} pide ampliar ${nombre(l)}: ${s.que}${s.cantidad ? ` (+${s.cantidad})` : ''}`,
    texto: `${l.empresa_nombre} (${l.empresa_uuid}) pide ampliar ${nombre(l)}.\n\nQué: ${s.que}\nCantidad: ${s.cantidad ?? '-'}\nComentario: ${s.comentario || '-'}\nPidió: ${s.solicitado_por}\n\nAtiéndelo en ${config.portalUrl}/licencias`,
  }),
};
