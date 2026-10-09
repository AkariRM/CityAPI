-- Lectura de facturas en Compras (XML, PDF y foto) — idempotente. Si ya habias corrido una version anterior de este archivo,
-- vuelve a correrlo completo: solo agrega lo que falte.
--
-- proveedores.rfc: el RFC del proveedor, para reconocer al emisor de una factura la proxima vez.
-- compras.uuid_factura: el UUID del timbre fiscal cuando la compra se registro leyendo el XML de la factura, con un
-- indice unico para no registrar dos veces la misma factura aunque cambie el folio capturado.
--
-- Sin BEGIN/COMMIT (el editor de Supabase corre cada sentencia por separado), se puede repetir.
-- Orden de publicacion: esta migracion -> Render (CityAPI) -> dist (CityApp).

ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS rfc text;

CREATE INDEX IF NOT EXISTS idx_proveedores_rfc ON proveedores(upper(rfc)) WHERE rfc IS NOT NULL;

ALTER TABLE compras ADD COLUMN IF NOT EXISTS uuid_factura text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_compras_uuid_factura ON compras(lower(uuid_factura))
  WHERE uuid_factura IS NOT NULL AND estado = 'registrada';

-- Margen sugerido (sobre el costo) para el precio de venta de los productos NUEVOS que se dan de alta desde una factura.
-- Arranca en 40 (costo + 40%) y se cambia en Configuracion.
ALTER TABLE configuracion_ticket
  ADD COLUMN IF NOT EXISTS compras_margen_producto_nuevo numeric(6,2) NOT NULL DEFAULT 40 CHECK (compras_margen_producto_nuevo >= 0 AND compras_margen_producto_nuevo <= 1000);

-- Comprobacion: deben salir 3 filas
SELECT table_name, column_name FROM information_schema.columns
WHERE (table_name = 'proveedores' AND column_name = 'rfc')
   OR (table_name = 'compras' AND column_name = 'uuid_factura')
   OR (table_name = 'configuracion_ticket' AND column_name = 'compras_margen_producto_nuevo')
ORDER BY table_name;
