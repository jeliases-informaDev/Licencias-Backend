// Error con codigo para la API: el manejador de app.js lo convierte en { error, mensaje } con el estado HTTP indicado.
export class ErrorApi extends Error {
  constructor(estado, codigo, mensaje) {
    super(mensaje);
    this.estado = estado;
    this.codigo = codigo;
  }
}
