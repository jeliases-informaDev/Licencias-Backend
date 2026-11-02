import { config } from './config.js';
import { migrar } from './bd.js';
import { crearApp } from './app.js';
import { iniciarTareas } from './tareas/programador.js';

await migrar();
const app = crearApp();
app.listen(config.puerto, () => console.log(`Servicio de licencias escuchando en el puerto ${config.puerto} (zona horaria ${config.zonaHoraria})`));
if (config.tareas) iniciarTareas();
