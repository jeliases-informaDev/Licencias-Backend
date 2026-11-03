// Lo que usa el Administrador General de una empresa (titular de la licencia). El universal puede mirar cualquier empresa con ?empresa=UUID.
import { Router } from 'express';
import { autenticarPersona } from '../auth/personas.js';
import * as s from '../licencias/servicio.js';

export const rutasMiLicencia = Router();
rutasMiLicencia.use(autenticarPersona);

rutasMiLicencia.get('/', async (req, res) => res.json(await s.misLicencias(req.persona, req.query.empresa)));
rutasMiLicencia.get('/:producto/consumos', async (req, res) => res.json(await s.misConsumos(req.persona, req.params.producto, req.query.periodo, req.query.empresa)));
rutasMiLicencia.post('/:producto/ampliar', async (req, res) => res.status(201).json(await s.solicitarAmpliacion(req.persona, req.params.producto, req.body || {}, req.query.empresa)));
