// Tareas periodicas dentro del mismo contenedor. Son idempotentes (los avisos se registran y no se repiten),
// asi que correrlas cada hora es seguro: a los 15 s de arrancar y luego cada hora.
import { aplicarVencimientos } from '../licencias/servicio.js';

export function iniciarTareas() {
  const correr = async () => {
    try {
      const r = await aplicarVencimientos();
      if (r.cambios || r.avisos) console.log(`Vencimientos: ${r.revisadas} licencias revisadas, ${r.cambios} cambios de estado, ${r.avisos} avisos`);
    } catch (e) {
      console.error('Tarea de vencimientos:', e.message);
    }
  };
  setTimeout(correr, 15_000).unref();
  setInterval(correr, 60 * 60 * 1000).unref();
}
