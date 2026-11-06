// Lo que usan los productos (token de producto). Contrato v1: Sulotec-infra/docs/licencias/ARQUITECTURA.md seccion 4.1.
import { Router } from 'express';
import { autenticarProducto } from '../auth/productos.js';
import { ErrorApi } from '../errores.js';
import { esUuid, exigir } from '../validar.js';
import * as s from '../licencias/servicio.js';

export const rutasProductos = Router();
rutasProductos.use(autenticarProducto);

const empresa = (req) => {
  exigir(esUuid(req.params.empresa), 'empresa debe ser el UUID de la empresa.');
  return req.params.empresa.toLowerCase();
};

rutasProductos.get('/licencias/:empresa', async (req, res) => res.json(await s.vistaDe(empresa(req), req.producto.clave)));
rutasProductos.get('/licencias/:empresa/cupo', async (req, res) => res.json(await s.cupoDe(empresa(req), req.producto.clave)));
rutasProductos.put('/licencias/:empresa/usuarios-activos', async (req, res) => res.json(await s.reportarActivos(empresa(req), req.producto.clave, req.body?.activos)));
rutasProductos.post('/licencias/:empresa/cuentas', async (req, res) => res.json(await s.cuentaDeUsuario(req.producto.clave, empresa(req), req.body || {})));
rutasProductos.post('/licencias/:empresa/consumos', async (req, res) => res.json(await s.consumir(req.producto.clave, empresa(req), req.body || {})));
// Solo Indira: contesta a una persona sobre todos los productos de su empresa. Los demas tokens solo ven su propia licencia.
rutasProductos.get('/empresas/:empresa/resumen', async (req, res) => {
  if (req.producto.clave !== 'indira') throw new ErrorApi(403, 'PRODUCTO_NO_AUTORIZADO', 'Este token de producto no puede leer el resumen de la empresa.');
  res.json(await s.resumenDeEmpresa(empresa(req)));
});
rutasProductos.delete('/consumos/:clave', async (req, res) => res.json(await s.anularConsumo(req.producto.clave, req.params.clave)));
