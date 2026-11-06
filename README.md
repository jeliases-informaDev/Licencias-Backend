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
Un consumo responde `{ permitido: true, cobrado, nivel: normal|aviso|tolerancia, disponibles, porcentaje }` o `{ permitido: false, motivo: BOLSA_AGOTADA|SOLO_LECTURA|SUSPENDIDA|SIN_LICENCIA }`. Repetir la misma clave devuelve la misma respuesta y no descuenta dos veces.

**Indira:** el servicio `indira` cobra 1 token por mensaje a su propia licencia (`tipo=mensaje_indira`) y no tiene cupo de usuarios. El plan semilla `Indira inicial` trae 500 tokens al mes (se ajusta por `/v1/admin/planes`); crea la licencia con ese plan o la bolsa queda en 0.
Solo su token puede pedir `GET /v1/empresas/{empresa_uuid}/resumen`: responde 200 con `{ empresa_uuid, productos: [{ producto, producto_nombre, plan, estado, usuarios_max, usuarios_activos, tokens, vencimiento, dias_para_vencer, titular_email }] }` (lista vacía si la empresa no tiene licencias). Cualquier otro token recibe 403 `PRODUCTO_NO_AUTORIZADO`. Indira recorta estos datos según quién pregunta y nunca le pasa `titular_email` al modelo.

**Cuentas de los usuarios (regla: todos los usuarios de una empresa entran con cuenta Sulotec; ninguna contraseña vive en el producto):**
el titular agrega al usuario desde el producto (allí elige su rol) y el producto llama a `POST /v1/licencias/{empresa_uuid}/cuentas {correo, nombre?, reinvitar?}`.
Sulotec crea la cuenta, la une al grupo de la empresa y le manda la invitación. Responde 200 con `{ estado, invitacion, clave_temporal?, mensaje }`
(la misma forma que `titular_cuenta`, más abajo): `estado` = `creada` | `existente` | `otra_empresa` | `sin_empresa` | `sin_keycloak` | `error`.
Los fallos de Keycloak no salen como error HTTP: llegan con `estado: 'error'` y el producto decide por el estado. Exige licencia de ese producto
(si no, 404 `SIN_LICENCIA`) y un correo válido (400). No revisa el cupo: el producto lo pide antes con `GET …/cupo`. Queda en la bitácora
(`cuenta_invitada`) con el producto, el estado y el tipo de invitación, nunca la clave temporal.

**Tarifas (Sulotec decide cuánto cuesta cada acción):** el producto solo avisa qué hizo con `tipo` (por ejemplo `scoring`). Si Sulotec tiene
tarifa para ese `tipo`, se descuentan los tokens de la tarifa y se ignora `cantidad`; sin tarifa se usa `cantidad` (o 1), como antes.
Toda respuesta permitida trae `cobrado` (tokens descontados). Tarifa en 0: la acción es gratis (`cobrado: 0`, no deja fila de consumo).
Tarifa con `bloquea: false` (por ejemplo el canal de denuncias): nunca se frena; si no hay saldo o la licencia está vencida/suspendida
responde `{ permitido: true, cobrado: 0, sin_descuento: true, motivo }` sin descontar. La licencia (`GET /v1/licencias/{empresa}`,
admin y «Mi licencia») trae `tarifas: [{ tipo, nombre, tokens, bloquea }]` para que el producto muestre el costo antes de hacer la acción.
Las tarifas iniciales de PLAFT están en `bd/esquema.sql`; después se cambian por la API.

**Universal:** `GET /v1/admin/tarifas?producto=plaft` · `PUT /v1/admin/tarifas/{producto}/{tipo} {nombre, tokens, bloquea, orden}` (crea o actualiza;
al crear, `nombre` y `tokens` son obligatorios; `tokens` de 0 a 1000; queda en la bitácora con el antes y el después), `/v1/admin/reglas`, `/v1/admin/productos/{clave}/token`, `/v1/admin/planes`, `/v1/admin/licencias` (`PATCH` con `accion`: ampliar, renovar, cambiar_plan, suspender, reactivar, cancelar, titular), `/v1/admin/licencias/{id}/bolsas-extra`, `/v1/admin/consumos?periodo_desde&periodo_hasta&formato=xlsx`, `/v1/admin/solicitudes`, `/v1/admin/bitacora`.

**Empresas (Keycloak):** `GET /v1/admin/empresas` (lista con uuid, nombre, slug y productos) y `POST /v1/admin/empresas {nombre, slug, productos}` (crea el subgrupo de «Empresas» con su UUID y da los roles `producto-*`). Al crear una licencia la empresa recibe el rol del producto; al cancelarla lo pierde. Requiere el cliente `licencias` de Keycloak (`KEYCLOAK_CLIENT_SECRET`).

**Cuenta del titular (reemplaza a `apps/cuenta/cuentas.sh`):** al crear una licencia con `titular_email` (y al cambiar el titular por otro correo
con `PATCH … {accion: "titular"}`) el servicio crea la cuenta Sulotec del titular, la une al grupo de su empresa y le manda la invitación para
crear su contraseña (vale 7 días; vuelve a `https://sulotec.com/mis-productos`). La respuesta trae
`titular_cuenta: { estado, invitacion, clave_temporal?, mensaje }`:
`estado` = `creada` | `existente` | `otra_empresa` (ya es de otra empresa: no se mueve) | `sin_empresa` (el UUID no está en «Empresas») |
`sin_keycloak` | `sin_titular` | `error`; `invitacion` = `correo` | `clave_temporal` (Keycloak no pudo mandar el correo: la clave se muestra
una sola vez, se cambia al entrar y no se guarda en ningún lado) | `ninguna`. Un fallo de Keycloak nunca impide ni revierte la licencia.
`POST /v1/admin/licencias/{id}/titular/invitar` vuelve a intentarlo (para licencias ya creadas): reinvita solo si la cuenta nunca terminó de
configurarse; si ya está activa, el titular usa «¿Olvidaste tu contraseña?». Cada intento queda en la bitácora (`titular_invitado`) sin la clave.

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
