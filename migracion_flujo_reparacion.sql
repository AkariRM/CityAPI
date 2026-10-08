-- Flujo de reparaciones por fases — idempotente.
--
-- Agrega reparaciones.cotizacion_aproximada: el estimado (opcional) que da el mostrador al recibir el equipo, sujeto
-- a diagnostico. No es la cotizacion final (total) ni se cobra.
-- Sin BEGIN/COMMIT (el editor de Supabase corre cada sentencia por separado), se puede repetir.
--
-- Orden de publicacion: esta migracion -> Render (CityAPI) -> dist (CityApp).

ALTER TABLE reparaciones ADD COLUMN IF NOT EXISTS cotizacion_aproximada numeric(12,2);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reparaciones_cotizacion_aproximada_check') THEN
    ALTER TABLE reparaciones ADD CONSTRAINT reparaciones_cotizacion_aproximada_check CHECK (cotizacion_aproximada >= 0);
  END IF;
END $$;

-- Comprobacion
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'reparaciones' AND column_name = 'cotizacion_aproximada';
