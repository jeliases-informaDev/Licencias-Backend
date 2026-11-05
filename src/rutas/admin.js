// Lo que usa el Administrador Universal de Sulotec (access token de Keycloak con el rol universal). Seccion 4.2 de ARQUITECTURA.md.
import { Router } from 'express';
import ExcelJS from 'exceljs';
import { autenticarPersona, soloUniversal } from '../auth/personas.js';
import { exigir } from '../validar.js';
import * as s from '../licencias/servicio.js';
import * as empresas from '../keycloak/empresas.js';

export const rutasAdmin = Router();
rutasAdmin.use(autenticarPersona, soloUniversal);

const id = (req) => {
  const n = Number(req.params.id);
  exigir(Number.isInteger(n) && n > 0, 'id inválido.');
  return n;
};
const quien = (req) => req.persona.usuario;

rutasAdmin.get('/reglas', async (req, res) => res.json(await s.listarReglas()));
rutasAdmin.patch('/reglas', async (req, res) => res.json(await s.actualizarReglas(req.body, quien(req))));

rutasAdmin.get('/empresas', async (req, res) => res.json(await empresas.listarEmpresas()));
rutasAdmin.post('/empresas', async (req, res) => {
  const e = await empresas.crearEmpresa(req.body || {});
  await s.anotar(quien(req), 'crear_empresa', e);
  res.status(201).json(e);
});

rutasAdmin.get('/productos', async (req, res) => res.json(await s.listarProductos()));
rutasAdmin.post('/productos/:clave/token', async (req, res) => res.status(201).json(await s.rotarToken(req.params.clave, quien(req))));

rutasAdmin.get('/tarifas', async (req, res) => res.json(await s.listarTarifas(req.query.producto)));
rutasAdmin.put('/tarifas/:producto/:tipo', async (req, res) => res.json(await s.guardarTarifa(req.params.producto, req.params.tipo, req.body || {}, quien(req))));

rutasAdmin.get('/planes',async (req, res) => res.json(await s.listarPlanes(req.query.producto)));
rutasAdmin.post('/planes', async (req, res) => res.status(201).json(await s.crearPlan(req.body || {}, quien(req))));
rutasAdmin.patch('/planes/:id', async (req, res) => res.json(await s.actualizarPlan(id(req), req.body || {}, quien(req))));

rutasAdmin.get('/licencias', async (req, res) => res.json(await s.listarLicencias(req.query)));
rutasAdmin.post('/licencias', async (req, res) => res.status(201).json(await s.crearLicencia(req.body || {}, quien(req))));
rutasAdmin.get('/licencias/:id', async (req, res) => res.json(await s.vistaPorId(id(req))));
rutasAdmin.patch('/licencias/:id', async (req, res) => res.json(await s.modificarLicencia(id(req), req.body || {}, quien(req))));
rutasAdmin.post('/licencias/:id/titular/invitar', async (req, res) => res.json(await s.invitarTitular(id(req), quien(req))));
rutasAdmin.post('/licencias/:id/bolsas-extra', async (req, res) => res.status(201).json(await s.agregarBolsaExtra(id(req), req.body || {}, quien(req))));
rutasAdmin.get('/licencias/:id/consumos', async (req, res) => {
  await s.vistaPorId(id(req));
  res.json(await s.consumosDe(id(req), req.query.periodo));
});

rutasAdmin.get('/consumos', async (req, res) => {
  const rep = await s.reporteConsumos(req.query);
  if (req.query.formato !== 'xlsx') return res.json(rep);
  const libro = new ExcelJS.Workbook();
  const resumen = libro.addWorksheet('Resumen');
  resumen.columns = [
    { header: 'Empresa', key: 'empresa_nombre', width: 32 }, { header: 'Producto', key: 'producto_nombre', width: 22 }, { header: 'Periodo', key: 'periodo', width: 10 },
    { header: 'Consultas', key: 'consultas', width: 11 }, { header: 'Tokens', key: 'tokens', width: 10 }, { header: 'De la bolsa', key: 'de_bolsa', width: 12 },
    { header: 'De paquetes extra', key: 'de_extra', width: 17 }, { header: 'Tolerancia (facturar)', key: 'tolerancia', width: 20 }, { header: 'Hecho por Sulotec', key: 'hecho_por_sulotec', width: 17 },
  ];
  resumen.addRows(rep.resumen);
  const detalle = libro.addWorksheet('Detalle');
  detalle.columns = [
    { header: 'Fecha y hora', key: 'creado_en', width: 22 }, { header: 'Empresa', key: 'empresa_nombre', width: 32 }, { header: 'Producto', key: 'producto_nombre', width: 22 },
    { header: 'Periodo', key: 'periodo', width: 10 }, { header: 'Usuario', key: 'usuario', width: 28 }, { header: 'Tipo', key: 'tipo', width: 20 }, { header: 'Cantidad', key: 'cantidad', width: 10 },
    { header: 'Nivel', key: 'nivel', width: 12 }, { header: 'Hecho por Sulotec', key: 'hecho_por_sulotec', width: 17 }, { header: 'En tolerancia', key: 'de_tolerancia', width: 13 },
  ];
  detalle.addRows(rep.detalle.map((f) => ({ ...f, hecho_por_sulotec: f.hecho_por_sulotec ? 'sí' : 'no' })));
  for (const hoja of [resumen, detalle]) hoja.getRow(1).font = { bold: true };
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="consumo-${rep.periodo_desde}-${rep.periodo_hasta}.xlsx"`);
  await libro.xlsx.write(res);
  res.end();
});

rutasAdmin.get('/solicitudes', async (req, res) => res.json(await s.listarSolicitudes({ pendientes: req.query.pendientes === '1' })));
rutasAdmin.patch('/solicitudes/:id', async (req, res) => res.json(await s.atenderSolicitud(id(req), quien(req))));
rutasAdmin.get('/bitacora', async (req, res) => res.json(await s.listarBitacora(req.query)));
