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

-- Comprobacion
SELECT
  (SELECT count(*) FROM information_schema.tables WHERE table_name IN ('compras', 'compra_items', 'producto_proveedor_claves')) AS tablas_nuevas,
  (SELECT count(*) FROM information_schema.columns WHERE table_name = 'venta_items' AND column_name = 'costo_unitario') AS venta_items_costo,
  (SELECT count(*) FROM information_schema.columns WHERE table_name = 'unidades_imei' AND column_name = 'compra_item_id') AS unidades_compra,
  (SELECT count(*) FROM information_schema.columns WHERE table_name = 'configuracion_ticket' AND column_name LIKE 'compras_%') AS config_columnas,
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'gastos_tipo_check') AS gastos_tipo;
