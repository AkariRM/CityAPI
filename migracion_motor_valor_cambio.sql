-- Motor de valor recomendado para "Cambio de equipo por dinero" — idempotente.
--
-- Agrega a configuracion_ticket los 5 números que el Administrador puede ajustar (Configuración):
--   - 3 deducciones en pesos por checklist (alta/media/baja, según qué tan cara es la pieza que falló)
--   - el factor de un equipo bloqueado con compañía
--   - el % que resta cada punto de estética por debajo de 8
-- No depende de BEGIN/COMMIT (el editor de Supabase corre cada sentencia por separado); ADD COLUMN
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

-- Comprobación
SELECT cambio_equipo_deduccion_alta, cambio_equipo_deduccion_media, cambio_equipo_deduccion_baja,
       cambio_equipo_factor_bloqueado, cambio_equipo_estetica_pct
FROM configuracion_ticket;
