-- Taller compartido, fase 3: traslados del equipo entre la sucursal y el taller. Idempotente.
-- Corre despues de migracion_taller_compartido.sql. Antes, revisa diagnostico_traslados.sql: muestra
-- en que ubicacion quedaria cada folio abierto (lo puedes corregir despues con el UPDATE del final).
--
--  - reparaciones.ubicacion: donde esta el equipo (sucursal / en_transito_taller / taller /
--    en_transito_sucursal) y reparaciones.en_taller_desde (la primera vez que el taller lo recibio).
--  - reparacion_traslados: quien envio y quien recibio cada traslado, y cuando.
--  - Folios que ya existen (solo la primera vez que corre): los abiertos en "diagnostico",
--    "esperando autorizacion" o "reparacion" se consideran ya EN EL TALLER; el resto (recibido,
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

-- Para corregir a mano un folio que quedo mal ubicado (ejemplo; cambia el folio y la ubicacion):
--   UPDATE reparaciones SET ubicacion = 'sucursal' WHERE folio = 'R-000123';
