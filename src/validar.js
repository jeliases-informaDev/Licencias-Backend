import { ErrorApi } from './errores.js';

export const esUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export const esFecha = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
export const esPeriodo = (v) => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
export const esCorreo = (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 200;
export const entero = (v, min = 0) => Number.isInteger(v) && v >= min;
export const texto = (v, max = 200) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

export function exigir(condicion, mensaje) {
  if (!condicion) throw new ErrorApi(400, 'DATOS_INVALIDOS', mensaje);
}
