ALTER TABLE reparaciones ALTER COLUMN cliente_id DROP NOT NULL;
ALTER TABLE reparaciones ADD COLUMN IF NOT EXISTS producto_id uuid REFERENCES productos(id);
ALTER TABLE reparaciones ADD COLUMN IF NOT EXISTS unidad_imei_id uuid REFERENCES unidades_imei(id);
ALTER TABLE reparaciones ADD COLUMN IF NOT EXISTS origen_reparacion text NOT NULL DEFAULT 'cliente'
  CHECK (origen_reparacion IN ('cliente', 'compra_propia'));
CREATE INDEX IF NOT EXISTS idx_reparaciones_producto ON reparaciones(producto_id);
