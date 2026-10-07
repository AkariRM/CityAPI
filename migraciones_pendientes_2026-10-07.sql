-- CityPhone SGI - migraciones pendientes (7-oct-2026). Idempotente: se puede correr completo mas de una vez.
--
-- Junta, en orden, las migraciones posteriores al esquema de produccion del 26-sep-2026. Cada una sigue existiendo por
-- separado como migracion_*.sql. Este archivo es solo para correrlas de un jalon. Sin BEGIN/COMMIT ni tablas temporales:
-- el editor de Supabase corre cada sentencia por separado y todo es CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- UPDATE repetible o un bloque DO.
--
--   1. Calcomania de equipo                         (configuracion_ticket.calcomania_equipo_codigo)
--   2. Opciones extra de estatus y chip             (tabla opciones_equipo)
--   3. Traslados taller <-> sucursal                (reparaciones.ubicacion, reparacion_traslados)
--   4. Inicio de sesion con correo y contrasena     (usuarios.password_hash, correos en minusculas, correo unico)
--   5. Motor de valor de "Cambio de equipo"         (5 columnas en configuracion_ticket)
--   6. Cambio de equipo aplicado a una venta        (cambios_equipo.venta_id)
--   7. Modo de caja por sucursal                    (sucursales.modo_caja)
--   8. Compras de inventario                        (compras, compra_items, claves del proveedor, costo al vender)
--
-- NO incluye migracion_taller_compartido.sql (se corrio el 26-sep). Esa une refacciones repetidas y no conviene repetirla.
-- La comprobacion del final avisa con taller_compartido = false si falta correrla antes que este archivo.
--
-- Si el indice unico de correos del punto 4 falla por "duplicate key", hay dos cuentas con el mismo correo (distinto solo
-- en mayusculas). Corrige una desde Usuarios y vuelve a correr este archivo.
--
-- Orden de publicacion: este archivo -> Render (CityAPI) -> dist (CityApp).

-- ======================================================================================
-- 1. Calcomania de equipo: codigo de barras o QR  (migracion_calcomania_equipo_codigo.sql)
-- ======================================================================================

-- Calcomania de equipo: que codigo lleva impreso. 'barras' = codigo de barras (Code 128) con el
-- IMEI, que se lee con un lector de mostrador, 'qr' = codigo QR como antes. Se cambia desde
-- Configuracion. Es idempotente: se puede correr mas de una vez.
ALTER TABLE configuracion_ticket
  ADD COLUMN IF NOT EXISTS calcomania_equipo_codigo text NOT NULL DEFAULT 'barras';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'configuracion_ticket_calcomania_equipo_codigo_check'
  ) THEN
    ALTER TABLE configuracion_ticket
      ADD CONSTRAINT configuracion_ticket_calcomania_equipo_codigo_check
      CHECK (calcomania_equipo_codigo IN ('barras', 'qr'));
  END IF;
END $$;

-- ======================================================================================
-- 2. Opciones extra de estatus y chip para equipos  (migracion_opciones_equipo.sql)
-- ======================================================================================

-- Opciones extra para el alta de equipos: estatus de companias y tipos de chip que agrega el
-- administrador desde "Nuevo equipo" (las de fabrica viven en la app). Idempotente.
--
-- IMPORTANTE: correr ANTES de desplegar la version del servidor que la usa (GET /opciones-equipo
-- consulta esta tabla).
CREATE TABLE IF NOT EXISTS opciones_equipo (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo        text NOT NULL CHECK (tipo IN ('estatus', 'chip')),
  -- Como se escribe en el nombre del equipo (mayusculas): "IZZI".
  valor       text NOT NULL,
  -- Como se ve en el selector: "Izzi".
  etiqueta    text NOT NULL,
  -- El valor sin espacios, guiones ni puntos: evita duplicados ("R-SIM" = "RSIM"), y unico entre
  -- estatus y chip juntos (un mismo nombre no puede ser las dos cosas).
  clave       text NOT NULL,
  creado_por  uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clave)
);

-- ======================================================================================
-- 3. Taller compartido, traslados del equipo entre sucursal y taller  (migracion_traslados.sql)
-- ======================================================================================

-- Taller compartido, fase 3: traslados del equipo entre la sucursal y el taller. Idempotente.
-- Corre despues de migracion_taller_compartido.sql. Antes, revisa diagnostico_traslados.sql: muestra
-- en que ubicacion quedaria cada folio abierto (lo puedes corregir despues con el UPDATE del final).
--
--  - reparaciones.ubicacion: donde esta el equipo (sucursal / en_transito_taller / taller /
--    en_transito_sucursal) y reparaciones.en_taller_desde (la primera vez que el taller lo recibio).
--  - reparacion_traslados: quien envio y quien recibio cada traslado, y cuando.
--  - Folios que ya existen (solo la primera vez que corre): los abiertos en "diagnostico",
--    "esperando autorizacion" o "reparacion" se consideran ya EN EL TALLER, el resto (recibido,
--    listo...) queda en la sucursal. Los folios con tecnico asignado que ya pasaron de "recibido"
--    cuentan como recibidos por el taller (asi el tecnico conserva su historial). Cada uno recibe un
--    traslado inicial marcado como "registro inicial".
--
-- Orden de publicacion: esta migracion -> Render -> dist.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ubicacion_reparacion') THEN
    CREATE TYPE ubicacion_reparacion AS ENUM ('sucursal', 'en_transito_taller', 'taller', 'en_transito_sucursal');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reparaciones' AND column_name = 'ubicacion') THEN
    ALTER TABLE reparaciones ADD COLUMN ubicacion ubicacion_reparacion NOT NULL DEFAULT 'sucursal';
    ALTER TABLE reparaciones ADD COLUMN en_taller_desde timestamptz;

    CREATE TABLE IF NOT EXISTS reparacion_traslados (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      reparacion_id  uuid NOT NULL REFERENCES reparaciones(id) ON DELETE CASCADE,
      sentido        text NOT NULL CHECK (sentido IN ('a_taller', 'a_sucursal')),
      enviado_por    uuid REFERENCES usuarios(id),
      enviado_at     timestamptz NOT NULL DEFAULT now(),
      recibido_por   uuid REFERENCES usuarios(id),
      recibido_at    timestamptz,
      nota           text
    );
    CREATE INDEX IF NOT EXISTS idx_reparacion_traslados_reparacion ON reparacion_traslados(reparacion_id, enviado_at);
    CREATE INDEX IF NOT EXISTS idx_reparaciones_ubicacion ON reparaciones(ubicacion);

    -- Folios abiertos que ya estan trabajando en el taller
    UPDATE reparaciones
    SET ubicacion = 'taller', en_taller_desde = COALESCE(updated_at, created_at)
    WHERE estado IN ('diagnostico', 'esperando_autorizacion', 'reparacion');

    -- Folios con tecnico que ya pasaron de "recibido" (incluye los ya entregados): el taller ya los vio
    UPDATE reparaciones
    SET en_taller_desde = created_at
    WHERE en_taller_desde IS NULL AND tecnico_id IS NOT NULL AND estado <> 'recibido';

    INSERT INTO reparacion_traslados (reparacion_id, sentido, enviado_at, recibido_at, nota)
    SELECT id, 'a_taller', created_at, en_taller_desde, 'Registro inicial (antes del seguimiento de traslados)'
    FROM reparaciones
    WHERE en_taller_desde IS NOT NULL;
  END IF;
END $$;

-- Para corregir a mano un folio que quedo mal ubicado (ejemplo, cambia el folio y la ubicacion):
--   UPDATE reparaciones SET ubicacion = 'sucursal' WHERE folio = 'R-000123',

-- ======================================================================================
-- 4. Inicio de sesion con correo y contrasena  (migracion_login_correo.sql)
-- ======================================================================================

-- Inicio de sesión con correo y contraseña — fase 0 (base de datos). Idempotente.
--
--  1. usuarios.password_hash: la contraseña para entrar con correo. Se llena con el MISMO cifrado del PIN, así que
--     el PIN actual de cada persona sirve como contraseña por el momento (bcrypt no distingue un PIN de una
--     contraseña). Al cambiar su contraseña, el PIN deja de servir.
--  2. Los correos existentes se guardan en minúsculas y sin espacios, y un correo solo puede pertenecer a una cuenta
--     (sin importar mayúsculas).
--
-- No borra ni cambia ningún PIN: el login actual por PIN sigue funcionando durante la transición.
-- Cada sentencia se puede repetir sin efecto (el editor de Supabase las corre por separado).
--
-- Si la ÚLTIMA sentencia falla por "duplicate key", hay dos cuentas con el mismo correo (distinto solo en
-- mayúsculas): corrige uno de los dos desde Usuarios y vuelve a correr este archivo.
--
-- Orden de publicación: esta migración -> Render -> dist.

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS password_hash text;

UPDATE usuarios SET password_hash = pin_hash WHERE password_hash IS NULL;

UPDATE usuarios SET email = NULLIF(lower(btrim(email)), '') WHERE email IS NOT NULL AND email IS DISTINCT FROM NULLIF(lower(btrim(email)), '');

CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_email_lower ON usuarios (lower(email)) WHERE email IS NOT NULL;

-- ======================================================================================
-- 5. Motor de valor de "Cambio de equipo por dinero"  (migracion_motor_valor_cambio.sql)
-- ======================================================================================

-- Motor de valor recomendado para "Cambio de equipo por dinero" — idempotente.
--
-- Agrega a configuracion_ticket los 5 números que el Administrador puede ajustar (Configuración):
--   - 3 deducciones en pesos por checklist (alta/media/baja, según qué tan cara es la pieza que falló)
--   - el factor de un equipo bloqueado con compañía
--   - el % que resta cada punto de estética por debajo de 8
-- No depende de BEGIN/COMMIT (el editor de Supabase corre cada sentencia por separado), ADD COLUMN
-- IF NOT EXISTS se puede repetir sin problema.
--
-- Orden de publicación: esta migración -> Render -> dist.

ALTER TABLE configuracion_ticket
  ADD COLUMN IF NOT EXISTS cambio_equipo_deduccion_alta   numeric(12,2) NOT NULL DEFAULT 400,
  ADD COLUMN IF NOT EXISTS cambio_equipo_deduccion_media  numeric(12,2) NOT NULL DEFAULT 150,
  ADD COLUMN IF NOT EXISTS cambio_equipo_deduccion_baja   numeric(12,2) NOT NULL DEFAULT 80,
  ADD COLUMN IF NOT EXISTS cambio_equipo_factor_bloqueado numeric(4,3) NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS cambio_equipo_estetica_pct     numeric(5,4) NOT NULL DEFAULT 0.03;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'configuracion_ticket_cambio_equipo_deduccion_alta_check') THEN
    ALTER TABLE configuracion_ticket ADD CONSTRAINT configuracion_ticket_cambio_equipo_deduccion_alta_check CHECK (cambio_equipo_deduccion_alta >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'configuracion_ticket_cambio_equipo_deduccion_media_check') THEN
    ALTER TABLE configuracion_ticket ADD CONSTRAINT configuracion_ticket_cambio_equipo_deduccion_media_check CHECK (cambio_equipo_deduccion_media >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'configuracion_ticket_cambio_equipo_deduccion_baja_check') THEN
    ALTER TABLE configuracion_ticket ADD CONSTRAINT configuracion_ticket_cambio_equipo_deduccion_baja_check CHECK (cambio_equipo_deduccion_baja >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'configuracion_ticket_cambio_equipo_factor_bloqueado_check') THEN
    ALTER TABLE configuracion_ticket ADD CONSTRAINT configuracion_ticket_cambio_equipo_factor_bloqueado_check CHECK (cambio_equipo_factor_bloqueado BETWEEN 0 AND 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'configuracion_ticket_cambio_equipo_estetica_pct_check') THEN
    ALTER TABLE configuracion_ticket ADD CONSTRAINT configuracion_ticket_cambio_equipo_estetica_pct_check CHECK (cambio_equipo_estetica_pct BETWEEN 0 AND 1);
  END IF;
END $$;

-- ======================================================================================
-- 6. Cambio de equipo aplicado a una venta  (migracion_cambio_aplicado_venta.sql)
-- ======================================================================================

-- "Aplicar a venta" de verdad: el cambio de equipo aceptado se puede usar como credito en una
-- venta nueva del Punto de Venta (ver POST /ventas, cambio_equipo_id). Antes ese boton solo
-- cambiaba el estado sin tocar ninguna venta -- ahora queda ligado a la venta donde se aplico.
-- Idempotente, sin BEGIN/COMMIT (el editor de Supabase corre cada sentencia por separado).
--
-- Orden de publicación: esta migración -> Render -> dist.

ALTER TABLE cambios_equipo
  ADD COLUMN IF NOT EXISTS venta_id uuid REFERENCES ventas(id);

-- ======================================================================================
-- 7. Modo de caja por sucursal  (migracion_modo_caja_sucursal.sql)
-- ======================================================================================

-- Modo de caja por sucursal: 'compartida' (un solo cajon fisico, el corte suma a TODOS los que
-- trabajaron ahi en el turno) o 'individual' (cada cajero cuenta y cuadra el suyo, comportamiento
-- que ya existia). Default 'compartida' porque es como ya opera la mayoria hoy en la practica.
-- Idempotente, sin BEGIN/COMMIT (el editor de Supabase corre cada sentencia por separado).
--
-- Orden de publicación: esta migración -> Render -> dist.

ALTER TABLE sucursales
  ADD COLUMN IF NOT EXISTS modo_caja text NOT NULL DEFAULT 'compartida';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sucursales_modo_caja_check') THEN
    ALTER TABLE sucursales ADD CONSTRAINT sucursales_modo_caja_check CHECK (modo_caja IN ('compartida', 'individual'));
  END IF;
END $$;

-- ======================================================================================
-- 8. Compras de inventario  (migracion_compras.sql)
-- ======================================================================================

-- Compras de inventario — idempotente.
--
-- Agrega: las tablas compras, compra_items y producto_proveedor_claves, la salida de caja tipo 'compra'
-- en gastos, el costo del momento en venta_items, la marca de unidades IMEI que vienen de una compra y
-- los 3 valores por omision de precios en Configuracion.
-- No depende de BEGIN/COMMIT ni de tablas temporales (el editor de Supabase corre cada sentencia por
-- separado): todo es CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT EXISTS o un bloque DO. Se puede repetir.
--
-- Orden de publicacion: esta migracion -> Render (CityAPI) -> dist (CityApp).

-- 1. Valores por omision de precios al registrar una compra (se pueden cambiar en cada compra)
ALTER TABLE configuracion_ticket
  ADD COLUMN IF NOT EXISTS compras_precios_modo       text NOT NULL DEFAULT 'margen' CHECK (compras_precios_modo IN ('margen', 'mantener')),
  ADD COLUMN IF NOT EXISTS compras_redondeo_multiplo  numeric(8,2) NOT NULL DEFAULT 5 CHECK (compras_redondeo_multiplo >= 0),
  ADD COLUMN IF NOT EXISTS compras_redondeo_direccion text NOT NULL DEFAULT 'arriba' CHECK (compras_redondeo_direccion IN ('arriba', 'abajo', 'cercano'));

-- 2. gastos.tipo admite 'compra' (salida de caja que genera una compra pagada con efectivo de la caja)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gastos_tipo_check' AND pg_get_constraintdef(oid) LIKE '%compra%') THEN
    ALTER TABLE gastos DROP CONSTRAINT IF EXISTS gastos_tipo_check;
    ALTER TABLE gastos ADD CONSTRAINT gastos_tipo_check CHECK (tipo IN ('gasto', 'retiro', 'compra'));
  END IF;
END $$;

-- 3. Costo del producto al momento de la venta (las ventas anteriores quedan en NULL)
ALTER TABLE venta_items ADD COLUMN IF NOT EXISTS costo_unitario numeric(12,2);

-- 4. Compras
CREATE SEQUENCE IF NOT EXISTS compras_folio_seq;

CREATE TABLE IF NOT EXISTS compras (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folio               text NOT NULL UNIQUE DEFAULT ('C-' || lpad(nextval('compras_folio_seq')::text, 6, '0')),
  proveedor_id        uuid NOT NULL REFERENCES proveedores(id),
  sucursal_id         uuid NOT NULL REFERENCES sucursales(id),
  folio_proveedor     text,
  fecha_factura       date NOT NULL DEFAULT current_date,
  iva_tasa            numeric(4,3) NOT NULL DEFAULT 0 CHECK (iva_tasa >= 0 AND iva_tasa <= 1),
  forma_pago          text NOT NULL CHECK (forma_pago IN ('efectivo', 'tarjeta', 'transferencia', 'cheque')),
  pagado_de_caja      boolean NOT NULL DEFAULT false,
  subtotal            numeric(12,2) NOT NULL DEFAULT 0,
  total               numeric(12,2) NOT NULL CHECK (total >= 0),
  precios_modo        text NOT NULL CHECK (precios_modo IN ('margen', 'mantener')),
  redondeo_multiplo   numeric(8,2) NOT NULL DEFAULT 0 CHECK (redondeo_multiplo >= 0),
  redondeo_direccion  text NOT NULL DEFAULT 'arriba' CHECK (redondeo_direccion IN ('arriba', 'abajo', 'cercano')),
  comentario          text,
  estado              text NOT NULL DEFAULT 'registrada' CHECK (estado IN ('registrada', 'cancelada')),
  gasto_id            uuid REFERENCES gastos(id) ON DELETE SET NULL,
  usuario_id          uuid NOT NULL REFERENCES usuarios(id),
  cancelada_at        timestamptz,
  cancelada_por       uuid REFERENCES usuarios(id),
  motivo_cancelacion  text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compras_sucursal ON compras(sucursal_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_compras_proveedor ON compras(proveedor_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_compras_proveedor_folio ON compras(proveedor_id, lower(folio_proveedor))
  WHERE folio_proveedor IS NOT NULL AND estado = 'registrada';

CREATE TABLE IF NOT EXISTS compra_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  compra_id          uuid NOT NULL REFERENCES compras(id) ON DELETE CASCADE,
  producto_id        uuid NOT NULL REFERENCES productos(id),
  cantidad           integer NOT NULL CHECK (cantidad > 0),
  piezas_por_unidad  integer NOT NULL DEFAULT 1 CHECK (piezas_por_unidad >= 1),
  piezas             integer NOT NULL CHECK (piezas > 0),
  costo_unitario     numeric(12,4) NOT NULL CHECK (costo_unitario >= 0),
  descuento_pct      numeric(5,2) NOT NULL DEFAULT 0 CHECK (descuento_pct >= 0 AND descuento_pct <= 100),
  descuento_monto    numeric(12,2) NOT NULL DEFAULT 0 CHECK (descuento_monto >= 0),
  importe            numeric(12,2) NOT NULL CHECK (importe >= 0),
  clave_proveedor    text,
  costo_pieza        numeric(12,4) NOT NULL,
  stock_antes        integer NOT NULL,
  costo_antes        numeric(12,2) NOT NULL,
  costo_despues      numeric(12,2) NOT NULL,
  precio_antes       numeric(12,2),
  precio_despues     numeric(12,2),
  mayoreo_antes      numeric(12,2),
  mayoreo_despues    numeric(12,2),
  revendedor_antes   numeric(12,2),
  revendedor_despues numeric(12,2),
  UNIQUE (compra_id, producto_id)
);

CREATE INDEX IF NOT EXISTS idx_compra_items_producto ON compra_items(producto_id);

-- 5. Unidades IMEI que vienen de una compra (para retirarlas si se cancela)
ALTER TABLE unidades_imei ADD COLUMN IF NOT EXISTS compra_item_id uuid REFERENCES compra_items(id) ON DELETE SET NULL;

-- 6. Clave de proveedor por producto
CREATE TABLE IF NOT EXISTS producto_proveedor_claves (
  proveedor_id  uuid NOT NULL REFERENCES proveedores(id) ON DELETE CASCADE,
  producto_id   uuid NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  clave         text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proveedor_id, producto_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_producto_proveedor_claves_clave ON producto_proveedor_claves(proveedor_id, lower(clave));

-- ======================================================================================
-- Comprobacion final: todo debe salir true (o 3 en tablas_compras)
-- ======================================================================================
SELECT
  EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'rol_usuario' AND e.enumlabel = 'supervisor_taller') AS taller_compartido,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'configuracion_ticket' AND column_name = 'calcomania_equipo_codigo') AS calcomania,
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'opciones_equipo') AS opciones_equipo,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reparaciones' AND column_name = 'ubicacion') AS traslados,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'usuarios' AND column_name = 'password_hash') AS login_correo,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'configuracion_ticket' AND column_name = 'cambio_equipo_estetica_pct') AS motor_valor,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cambios_equipo' AND column_name = 'venta_id') AS cambio_aplicado,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sucursales' AND column_name = 'modo_caja') AS modo_caja,
  (SELECT count(*) FROM information_schema.tables WHERE table_name IN ('compras', 'compra_items', 'producto_proveedor_claves')) AS tablas_compras,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'venta_items' AND column_name = 'costo_unitario') AS costo_al_vender,
  (SELECT count(*) FROM usuarios WHERE email IS NULL AND activo) AS usuarios_activos_sin_correo;
