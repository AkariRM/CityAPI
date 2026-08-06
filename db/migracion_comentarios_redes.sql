-- ============================================================================
-- Migración: Comentarios y reseñas (bandeja interna, sin sugerencia por IA)
-- Ejecutar en el SQL editor de Supabase (producción ya tiene datos).
-- ============================================================================

CREATE TYPE estado_comentario AS ENUM ('pendiente', 'respondido', 'descartado');

CREATE TABLE comentarios_redes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plataforma      plataforma_publicacion NOT NULL,
  publicacion_id  uuid REFERENCES publicaciones(id),
  autor_nombre    text NOT NULL,
  contenido       text NOT NULL,
  estado          estado_comentario NOT NULL DEFAULT 'pendiente',
  respuesta       text,
  respondido_por  uuid REFERENCES usuarios(id),
  respondido_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_comentarios_redes_estado ON comentarios_redes(estado);
