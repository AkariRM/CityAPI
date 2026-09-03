-- Galería de imágenes por producto (hasta 10, controlado por la API).
-- productos.imagen_url no se toca ni se elimina: se sigue usando tal cual
-- en todo lo que ya lo lee (calcomanías, marketplace, tarjetas), y a partir
-- de ahora la API lo mantiene sincronizado con la imagen marcada como
-- principal aquí.
CREATE TABLE IF NOT EXISTS producto_imagenes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  producto_id  uuid NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  imagen_url   text NOT NULL,
  es_principal boolean NOT NULL DEFAULT false,
  orden        integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_producto_imagenes_producto ON producto_imagenes(producto_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_producto_imagenes_principal_unica ON producto_imagenes(producto_id) WHERE es_principal;

-- Backfill: los productos que ya tienen imagen_url hoy pasan a tener esa
-- misma foto como su primera imagen de galería (principal) — así no
-- "desaparece" ninguna foto ya subida al activar la galería.
INSERT INTO producto_imagenes (producto_id, imagen_url, es_principal, orden)
SELECT id, imagen_url, true, 0
FROM productos
WHERE imagen_url IS NOT NULL
ON CONFLICT DO NOTHING;
