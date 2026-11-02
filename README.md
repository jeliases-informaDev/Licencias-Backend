# Licencias de Sulotec (servicio común)

Un solo servicio decide todo lo de licencias para **todos** los productos de Sulotec: planes, cupo de usuarios, bolsa de tokens,
consumo con clave idempotente, avisos, vencimientos y bitácora. Los productos no implementan reglas: le preguntan y le reportan.

- Modelo de negocio: [`docs/licencias/LICENCIAS.md`](https://github.com/Sulotec/Sulotec-infra/blob/main/docs/licencias/LICENCIAS.md) (Sulotec-infra).
- Diseño técnico y contrato de la API: [`docs/licencias/ARQUITECTURA.md`](https://github.com/Sulotec/Sulotec-infra/blob/main/docs/licencias/ARQUITECTURA.md).
- Kit del servidor (compose, preparar, desplegar, probar): `apps/licencias` en Sulotec-infra.

## Qué hay

| Carpeta | Qué |
|---|---|
| `bd/esquema.sql` | Tablas (idempotente; se aplica en cada arranque) y reglas de negocio como parámetros |
| `src/licencias/reglas.js` | Las reglas puras (estado por fecha, cupo, consumo con 80 % / tolerancia / bloqueo). Sin base de datos |
| `src/licencias/servicio.js` | Operaciones sobre la base: lectura, consumo idempotente, administración, «Mi licencia», vencimientos |
| `src/rutas/productos.js` | API para los productos (`Authorization: Bearer <token del producto>`) |
| `src/rutas/admin.js` | API del Administrador Universal (access token de Keycloak con `administrador-general`) |
| `src/rutas/mi-licencia.js` | API del Administrador General de cada empresa (titular de la licencia) |
| `src/tareas/programador.js` | Vencimientos y avisos, cada hora (idempotente) |
| `scripts/token-producto.js` | Genera o rota el token de un producto (se muestra una sola vez) |

## API en dos líneas

**Productos:** `GET /v1/licencias/{empresa_uuid}` · `GET …/cupo` · `PUT …/usuarios-activos {activos}` · `POST …/consumos {clave_idempotente, tipo, cantidad, usuario, hecho_por_sulotec}` · `DELETE /v1/consumos/{clave}`.
Un consumo responde `{ permitido: true, nivel: normal|aviso|tolerancia, disponibles, porcentaje }` o `{ permitido: false, motivo: BOLSA_AGOTADA|SOLO_LECTURA|SUSPENDIDA|SIN_LICENCIA }`. Repetir la misma clave devuelve la misma respuesta y no descuenta dos veces.

**Universal:** `/v1/admin/reglas`, `/v1/admin/productos/{clave}/token`, `/v1/admin/planes`, `/v1/admin/licencias` (`PATCH` con `accion`: ampliar, renovar, cambiar_plan, suspender, reactivar, cancelar, titular), `/v1/admin/licencias/{id}/bolsas-extra`, `/v1/admin/consumos?periodo_desde&periodo_hasta&formato=xlsx`, `/v1/admin/solicitudes`, `/v1/admin/bitacora`.

**Empresa:** `GET /v1/mi-licencia`, `GET /v1/mi-licencia/{producto}/consumos?periodo=AAAA-MM`, `POST /v1/mi-licencia/{producto}/ampliar {que, cantidad, comentario}`.

Todos los errores son JSON `{ error, mensaje }` con el mensaje listo para mostrar.

## Correr en local

```bash
docker run -d --name licencias-pg -e POSTGRES_PASSWORD=prueba -e POSTGRES_DB=licencias -p 55432:5432 postgres:16-alpine
npm install
cp .env.ejemplo .env
npm run dev
```

Pruebas (las de reglas no necesitan base; las de API usan el PostgreSQL de arriba):

```bash
DATABASE_URL_PRUEBA=postgresql://postgres:prueba@localhost:55432/licencias npm test
```

Token para un producto (en el servidor: `sudo docker exec licencias node scripts/token-producto.js geomatrix`):

```bash
node --env-file=.env scripts/token-producto.js geomatrix
```

## Variables

Ver `.env.ejemplo`. Sin `SMTP_HOST`, los correos solo se escriben en el log. `KEYCLOAK_JWKS_LOCAL` es solo para pruebas.
