-- Esquema del servicio de licencias de Sulotec. Idempotente: se aplica en cada arranque y solo crea lo que falta.
-- El modelo esta explicado en Sulotec-infra/docs/licencias/ARQUITECTURA.md (seccion 3).

CREATE TABLE IF NOT EXISTS productos (
  clave text PRIMARY KEY,
  nombre text NOT NULL,
  usa_tokens boolean NOT NULL DEFAULT false,
  token_hash text,
  token_rotado_en timestamptz
);
INSERT INTO productos (clave, nombre, usa_tokens) VALUES
  ('geomatrix', 'GeoMatrix', false),
  ('miradar360', 'MiRadar 360', true),
  ('plaft', 'PLAFT', true),
  ('buscador', 'Buscador Interno', true),
  ('dashboard', 'Dashboard Empresarial', false)
ON CONFLICT (clave) DO NOTHING;

-- Parametros de negocio: se cambian desde /v1/admin/reglas sin programar.
CREATE TABLE IF NOT EXISTS reglas (
  clave text PRIMARY KEY,
  valor text NOT NULL,
  descripcion text
);
INSERT INTO reglas (clave, valor, descripcion) VALUES
  ('aviso_porcentaje', '80', 'Porcentaje de la bolsa a partir del cual se avisa al titular'),
  ('tolerancia_porcentaje', '10', 'Porcentaje sobre la capacidad del periodo que se permite consumir con la bolsa agotada y se factura aparte'),
  ('vencimiento_aviso_dias', '7', 'Dias antes del vencimiento para avisar al titular'),
  ('solo_lectura_dias', '7', 'Dias en solo lectura despues de vencer, antes de suspender'),
  ('bolsa_extra_vigencia_meses', '12', 'Meses de vigencia de un paquete extra de tokens')
ON CONFLICT (clave) DO NOTHING;

CREATE TABLE IF NOT EXISTS planes (
  id serial PRIMARY KEY,
  producto text NOT NULL REFERENCES productos (clave),
  nombre text NOT NULL,
  usuarios_max integer NOT NULL CHECK (usuarios_max >= 0),
  tokens_periodo integer NOT NULL DEFAULT 0 CHECK (tokens_periodo >= 0),
  periodo text NOT NULL DEFAULT 'mensual',
  precio numeric(10, 2),
  activo boolean NOT NULL DEFAULT true,
  creado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (producto, nombre)
);

-- Una licencia por empresa y producto. empresa_uuid es el mismo de Keycloak y del producto.
CREATE TABLE IF NOT EXISTS licencias (
  id serial PRIMARY KEY,
  empresa_uuid uuid NOT NULL,
  empresa_nombre text NOT NULL,
  producto text NOT NULL REFERENCES productos (clave),
  plan_id integer REFERENCES planes (id),
  usuarios_max integer NOT NULL CHECK (usuarios_max >= 0),
  tokens_periodo integer NOT NULL DEFAULT 0 CHECK (tokens_periodo >= 0),
  inicio date NOT NULL,
  vencimiento date NOT NULL,
  estado text NOT NULL DEFAULT 'ACTIVA' CHECK (estado IN ('ACTIVA', 'SOLO_LECTURA', 'SUSPENDIDA', 'CANCELADA')),
  titular_email text,
  titular_nombre text,
  creado_por text NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_uuid, producto)
);
CREATE INDEX IF NOT EXISTS licencias_titular ON licencias (lower(titular_email));

-- Contador del mes: consumidos (de la bolsa del periodo), de_extra (de paquetes extra) y tolerancia (por encima de todo).
CREATE TABLE IF NOT EXISTS periodos (
  licencia_id integer NOT NULL REFERENCES licencias (id) ON DELETE CASCADE,
  periodo text NOT NULL,
  bolsa integer NOT NULL,
  consumidos integer NOT NULL DEFAULT 0,
  de_extra integer NOT NULL DEFAULT 0,
  tolerancia integer NOT NULL DEFAULT 0,
  aviso_en timestamptz,
  PRIMARY KEY (licencia_id, periodo)
);

CREATE TABLE IF NOT EXISTS bolsas_extra (
  id serial PRIMARY KEY,
  licencia_id integer NOT NULL REFERENCES licencias (id) ON DELETE CASCADE,
  cantidad integer NOT NULL CHECK (cantidad > 0),
  restante integer NOT NULL CHECK (restante >= 0),
  vence date NOT NULL,
  creado_por text NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now()
);

-- Cada token consumido, con la clave idempotente que manda el producto (repetirla no descuenta dos veces).
CREATE TABLE IF NOT EXISTS consumos (
  id bigserial PRIMARY KEY,
  licencia_id integer NOT NULL REFERENCES licencias (id) ON DELETE CASCADE,
  periodo text NOT NULL,
  usuario text,
  tipo text NOT NULL,
  cantidad integer NOT NULL CHECK (cantidad > 0),
  hecho_por_sulotec boolean NOT NULL DEFAULT false,
  nivel text NOT NULL,
  de_bolsa integer NOT NULL DEFAULT 0,
  de_extra integer NOT NULL DEFAULT 0,
  de_tolerancia integer NOT NULL DEFAULT 0,
  extras_usados jsonb NOT NULL DEFAULT '[]',
  clave_idempotente text NOT NULL UNIQUE,
  detalle jsonb,
  respuesta jsonb NOT NULL,
  anulado_en timestamptz,
  creado_en timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consumos_licencia_periodo ON consumos (licencia_id, periodo);

CREATE TABLE IF NOT EXISTS usuarios_activos (
  licencia_id integer PRIMARY KEY REFERENCES licencias (id) ON DELETE CASCADE,
  activos integer NOT NULL CHECK (activos >= 0),
  reportado_en timestamptz NOT NULL DEFAULT now()
);

-- Un aviso por licencia, tipo y periodo (o fecha de vencimiento): asi no se repiten.
CREATE TABLE IF NOT EXISTS avisos (
  id serial PRIMARY KEY,
  licencia_id integer NOT NULL REFERENCES licencias (id) ON DELETE CASCADE,
  tipo text NOT NULL,
  periodo text NOT NULL,
  destinatario text,
  enviado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (licencia_id, tipo, periodo)
);

CREATE TABLE IF NOT EXISTS solicitudes (
  id serial PRIMARY KEY,
  licencia_id integer NOT NULL REFERENCES licencias (id) ON DELETE CASCADE,
  que text NOT NULL CHECK (que IN ('usuarios', 'tokens', 'plan')),
  cantidad integer,
  comentario text,
  solicitado_por text NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now(),
  atendido_en timestamptz,
  atendido_por text
);

CREATE TABLE IF NOT EXISTS bitacora (
  id bigserial PRIMARY KEY,
  quien text NOT NULL,
  accion text NOT NULL,
  licencia_id integer,
  antes jsonb,
  despues jsonb,
  cuando timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bitacora_licencia ON bitacora (licencia_id, cuando DESC);
