-- Horario por sucursal y politicas del negocio — idempotente, se puede repetir.
--
-- sucursales.horario: horario de atencion en texto libre, para que el agente de WhatsApp lo diga.
-- politicas_negocio: lo oficial que el agente puede afirmar (garantia, pagos, apartados, envios...). Se editan en
-- Administracion > Politicas. Un tema con el texto vacio esta pendiente de definir y el agente no lo ve.
--
-- Sin BEGIN/COMMIT (el editor de Supabase corre cada sentencia por separado). Los 6 temas iniciales no pisan lo que ya
-- hayas escrito: si el tema ya existe no se toca.
-- Orden de publicacion: esta migracion -> Render (CityAPI) -> dist (CityApp).

ALTER TABLE sucursales ADD COLUMN IF NOT EXISTS horario text;

CREATE TABLE IF NOT EXISTS politicas_negocio (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tema        text NOT NULL UNIQUE,
  titulo      text NOT NULL,
  contenido   text NOT NULL DEFAULT '',
  activo      boolean NOT NULL DEFAULT true,
  orden       integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO politicas_negocio (tema, titulo, orden) VALUES
  ('garantia', 'Garantía', 1),
  ('pagos', 'Formas de pago', 2),
  ('apartados', 'Apartados', 3),
  ('envios', 'Envíos', 4),
  ('diagnostico', 'Diagnóstico de reparaciones', 5),
  ('facturacion', 'Facturación', 6)
ON CONFLICT (tema) DO NOTHING;

-- Comprobacion: debe salir 1 fila de la columna y 6 o mas de politicas
SELECT 'sucursales.horario' AS que, count(*)::int AS filas FROM information_schema.columns WHERE table_name = 'sucursales' AND column_name = 'horario'
UNION ALL
SELECT 'politicas_negocio', count(*)::int FROM politicas_negocio;
