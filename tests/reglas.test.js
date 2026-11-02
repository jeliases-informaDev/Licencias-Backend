import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluarConsumo, resumenTokens, evaluarCupo, estadoCalculado, sumarMeses, diasPara, fechaLocal } from '../src/licencias/reglas.js';

test('resumen de la bolsa: porcentaje y nivel', () => {
  const r = resumenTokens({ bolsa: 100, consumidos: 50 });
  assert.equal(r.porcentaje, 50);
  assert.equal(r.nivel, 'normal');
  assert.equal(r.disponibles, 50);
  assert.equal(resumenTokens({ bolsa: 100, consumidos: 80 }).nivel, 'aviso');
  assert.equal(resumenTokens({ bolsa: 100, consumidos: 100 }).nivel, 'tolerancia');
  assert.equal(resumenTokens({ bolsa: 100, consumidos: 100, tolerancia: 10 }).nivel, 'bloqueado');
});

test('consumo normal y cruce del 80 %', () => {
  const normal = evaluarConsumo({ bolsa: 100, consumidos: 10, cantidad: 1 });
  assert.equal(normal.permitido, true);
  assert.equal(normal.nivel, 'normal');
  assert.deepEqual(normal.reparto, { deBolsa: 1, deExtra: 0, deTolerancia: 0 });
  const aviso = evaluarConsumo({ bolsa: 100, consumidos: 79, cantidad: 1 });
  assert.equal(aviso.nivel, 'aviso');
  assert.equal(aviso.avisar, true);
  assert.equal(evaluarConsumo({ bolsa: 100, consumidos: 80, cantidad: 1 }).avisar, false, 'solo avisa al cruzar');
});

test('los paquetes extra se usan cuando la bolsa del mes se acaba', () => {
  const r = evaluarConsumo({ bolsa: 100, consumidos: 98, restanteExtra: 20, cantidad: 5 });
  assert.equal(r.permitido, true);
  assert.deepEqual(r.reparto, { deBolsa: 2, deExtra: 3, deTolerancia: 0 });
  assert.equal(r.capacidad, 120);
  assert.equal(r.usados, 103);
  assert.equal(r.disponibles, 17);
});

test('tolerancia del 10 % y bloqueo', () => {
  const t = evaluarConsumo({ bolsa: 100, consumidos: 100, cantidad: 1 });
  assert.equal(t.permitido, true);
  assert.equal(t.nivel, 'tolerancia');
  assert.equal(t.avisarTolerancia, true);
  assert.equal(t.toleranciaMax, 10);
  const ultimo = evaluarConsumo({ bolsa: 100, consumidos: 100, tolerancia: 9, cantidad: 1 });
  assert.equal(ultimo.permitido, true);
  const bloqueado = evaluarConsumo({ bolsa: 100, consumidos: 100, tolerancia: 10, cantidad: 1 });
  assert.equal(bloqueado.permitido, false);
  assert.equal(bloqueado.motivo, 'BOLSA_AGOTADA');
  const muchos = evaluarConsumo({ bolsa: 100, consumidos: 95, cantidad: 20 });
  assert.equal(muchos.permitido, false, 'una cantidad que supera bolsa + tolerancia se rechaza entera');
});

test('lo hecho por Sulotec nunca se bloquea pero se descuenta', () => {
  const r = evaluarConsumo({ bolsa: 100, consumidos: 100, tolerancia: 10, cantidad: 1, hechoPorSulotec: true });
  assert.equal(r.permitido, true);
  assert.equal(r.reparto.deTolerancia, 1);
  const vencida = evaluarConsumo({ estado: 'SOLO_LECTURA', bolsa: 100, cantidad: 1, hechoPorSulotec: true });
  assert.equal(vencida.permitido, true);
});

test('licencia vencida o suspendida no consume', () => {
  assert.equal(evaluarConsumo({ estado: 'SOLO_LECTURA', bolsa: 100, cantidad: 1 }).motivo, 'SOLO_LECTURA');
  assert.equal(evaluarConsumo({ estado: 'SUSPENDIDA', bolsa: 100, cantidad: 1 }).motivo, 'SUSPENDIDA');
  assert.equal(evaluarConsumo({ estado: 'CANCELADA', bolsa: 100, cantidad: 1 }).motivo, 'SIN_LICENCIA');
  assert.equal(evaluarConsumo({ bolsa: 100, cantidad: 0 }).motivo, 'CANTIDAD_INVALIDA');
});

test('estado segun la fecha: activa hasta el dia del vencimiento, 7 dias en solo lectura, luego suspendida', () => {
  const l = { estado: 'ACTIVA', vencimiento: '2026-11-10' };
  assert.equal(estadoCalculado(l, '2026-11-10'), 'ACTIVA');
  assert.equal(estadoCalculado(l, '2026-11-11'), 'SOLO_LECTURA');
  assert.equal(estadoCalculado(l, '2026-11-17'), 'SOLO_LECTURA');
  assert.equal(estadoCalculado(l, '2026-11-18'), 'SUSPENDIDA');
  assert.equal(estadoCalculado({ estado: 'SUSPENDIDA', vencimiento: '2099-01-01' }, '2026-11-10'), 'SUSPENDIDA', 'una suspension manual se respeta');
  assert.equal(estadoCalculado(l, '2026-11-12', { soloLecturaDias: 1 }), 'SUSPENDIDA');
});

test('cupo de usuarios', () => {
  assert.equal(evaluarCupo({ activos: 2, usuariosMax: 3 }).puedeCrear, true);
  assert.equal(evaluarCupo({ activos: 3, usuariosMax: 3 }).puedeCrear, false);
  assert.equal(evaluarCupo({ activos: 5, usuariosMax: 3 }).libres, 0);
});

test('fechas', () => {
  assert.equal(sumarMeses('2026-01-31', 1), '2026-02-28');
  assert.equal(sumarMeses('2026-11-02', 12), '2027-11-02');
  assert.equal(diasPara('2026-11-09', '2026-11-02'), 7);
  assert.match(fechaLocal(new Date('2026-11-02T03:00:00Z'), 'America/Lima'), /^2026-11-01$/, 'a las 3 UTC todavia es 1 de noviembre en Lima');
});
