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
