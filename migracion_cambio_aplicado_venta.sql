-- "Aplicar a venta" de verdad: el cambio de equipo aceptado se puede usar como credito en una
-- venta nueva del Punto de Venta (ver POST /ventas, cambio_equipo_id). Antes ese boton solo
-- cambiaba el estado sin tocar ninguna venta -- ahora queda ligado a la venta donde se aplico.
-- Idempotente, sin BEGIN/COMMIT (el editor de Supabase corre cada sentencia por separado).
--
-- Orden de publicación: esta migración -> Render -> dist.

ALTER TABLE cambios_equipo
  ADD COLUMN IF NOT EXISTS venta_id uuid REFERENCES ventas(id);

-- Comprobación
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'cambios_equipo' AND column_name = 'venta_id';
