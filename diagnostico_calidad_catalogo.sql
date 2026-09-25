-- Diagnostico de calidad del catalogo que ve el agente de WhatsApp (TRAI).
--
-- ES SOLO LECTURA: un SELECT, no cambia nada. Se corre completo en el editor SQL de
-- Supabase. Tal como esta devuelve el RESUMEN (cuantos hay de cada problema, por
-- gravedad). Para ver los productos concretos, al pie del archivo hay dos versiones del
-- SELECT final: el detalle de todos los problemas y el detalle de uno solo.
--
-- "Lo que ve el agente" = mismo criterio que GET /catalogo-externo: productos activos con
-- existencia disponible (existencias menos apartados, en cualquier sucursal) o servicios.
-- Las revisiones de apartados fantasma miran TODOS los productos activos, porque justo
-- esos son los que el catalogo esconde.
--
--   ALTA   el agente puede dar un dato equivocado, o un equipo no aparece cuando debia.
--   MEDIA  el agente no puede contestar algo que el cliente suele preguntar.
--   BAJA   detalle de captura.
--
-- Columnas del detalle: severidad, problema, total_del_problema, producto_id, nombre,
-- tipo, precio_venta y detalle (el dato concreto a corregir).
--
-- Los umbrales de precio se ajustan en el CTE "umbrales" de abajo.

WITH umbrales AS (
  SELECT 0.60::numeric AS factor_bajo,     -- precio < 60% de la mediana del mismo modelo
         1.50::numeric AS factor_alto,     -- precio > 150% de la mediana del mismo modelo
         3             AS min_del_modelo,  -- solo se compara si hay al menos 3 del mismo modelo
         2500::numeric AS precio_minimo    -- un celular completo por debajo de esto es sospechoso
),
visibles AS (
  SELECT p.*
  FROM productos p
  WHERE p.activo = true
    AND (
      p.tipo = 'servicio'
      OR EXISTS (
        SELECT 1 FROM inventario i
        WHERE i.producto_id = p.id AND i.stock_cantidad - i.stock_apartado > 0
      )
    )
),
equipos AS (
  SELECT v.*, upper(regexp_replace(v.nombre, '\s+', ' ', 'g')) AS nombre_norm
  FROM visibles v
  WHERE v.tipo IN ('nuevo', 'usado')
),

-- Bateria de cada unidad, con la misma regla del catalogo: "97%" o "Bateria 97%" -> 97;
-- "sellado"/"nuevo"/"nueva" -> 100; cualquier otra cosa -> sin dato.
unidades AS (
  SELECT u.producto_id, u.estado, u.condicion,
         COALESCE(
           substring(u.condicion from '(?:^|[^0-9A-Za-z_])([0-9]{1,3})\s?%')::int,
           CASE WHEN u.condicion ~* '(^|[^a-z0-9])(sellado|nuevo|nueva)($|[^a-z0-9])' THEN 100 END
         ) AS salud
  FROM unidades_imei u
),
bateria AS (
  SELECT producto_id,
         count(*) FILTER (WHERE condicion IS NOT NULL AND btrim(condicion) <> '') AS con_condicion,
         count(salud) AS con_salud,
         count(DISTINCT salud) AS saludes_distintas,
         max(salud) AS salud_max,
         min(salud) AS salud_min,
         string_agg(DISTINCT condicion, ' | ') FILTER (WHERE condicion IS NOT NULL AND btrim(condicion) <> '') AS condiciones
  FROM unidades
  GROUP BY producto_id
),

-- Estatus de compania/desbloqueo que trae el nombre (mismos que usa la app al capturar).
estatus AS (
  SELECT e.id,
         array_remove(ARRAY[
           CASE WHEN e.nombre_norm ~ '(^|[^A-Z0-9])NO LIBRE($|[^A-Z0-9])' THEN 'NO LIBRE' END,
           CASE WHEN replace(e.nombre_norm, 'NO LIBRE', '') ~ '(^|[^A-Z0-9])LIBRE($|[^A-Z0-9])' THEN 'LIBRE' END,
           CASE WHEN e.nombre_norm ~ '(^|[^A-Z0-9])AT&T($|[^A-Z0-9])' THEN 'AT&T' END,
           CASE WHEN e.nombre_norm ~ '(^|[^A-Z0-9])MDM($|[^A-Z0-9])' THEN 'MDM' END,
           CASE WHEN e.nombre_norm ~ '(^|[^A-Z0-9])MEP($|[^A-Z0-9])' THEN 'MEP' END,
           CASE WHEN e.nombre_norm ~ '(^|[^A-Z0-9])R-?SIM($|[^A-Z0-9])' THEN 'RSIM' END,
           CASE WHEN e.nombre_norm ~ '(^|[^A-Z0-9])TELCEL($|[^A-Z0-9])' THEN 'TELCEL' END,
           CASE WHEN e.nombre_norm ~ '(^|[^A-Z0-9])MOVISTAR($|[^A-Z0-9])' THEN 'MOVISTAR' END
         ], NULL) AS lista
  FROM equipos e
),

-- Mediana de precio por modelo (mismo nombre normalizado).
por_modelo AS (
  SELECT nombre_norm,
         count(*) AS n,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY precio_venta) AS mediana
  FROM equipos
  WHERE precio_venta > 0
  GROUP BY nombre_norm
),

-- Apartados: lo que dice inventario contra la suma de los apartados activos de verdad.
apartados_activos AS (
  SELECT producto_id, sucursal_id, sum(cantidad)::int AS n
  FROM apartados
  WHERE estado = 'activo'
  GROUP BY producto_id, sucursal_id
),

problemas AS (

  -- ── ALTA ────────────────────────────────────────────────────────────────
  SELECT 'ALTA' AS severidad, 'Precio en cero o negativo' AS problema, e.id, e.nombre, e.tipo, e.precio_venta,
         'precio_venta = ' || e.precio_venta AS detalle
  FROM visibles e
  WHERE e.tipo <> 'servicio' AND e.precio_venta <= 0

  UNION ALL
  SELECT 'ALTA', 'Precio menor o igual al costo', e.id, e.nombre, e.tipo, e.precio_venta,
         'precio $' || e.precio_venta || ' / costo $' || e.costo
  FROM visibles e
  WHERE e.tipo <> 'servicio' AND e.costo > 0 AND e.precio_venta > 0 AND e.precio_venta <= e.costo

  UNION ALL
  SELECT 'ALTA', 'Nombre con dos estatus', e.id, e.nombre, e.tipo, e.precio_venta,
         'el nombre dice: ' || array_to_string(s.lista, ' y ')
  FROM equipos e JOIN estatus s ON s.id = e.id
  WHERE cardinality(s.lista) >= 2

  UNION ALL
  SELECT 'ALTA', 'Sale en el catalogo pero ya no tiene unidades disponibles', e.id, e.nombre, e.tipo, e.precio_venta,
         'existencia disponible pero sus unidades estan: ' ||
         (SELECT string_agg(x.estado || ' x' || x.n, ', ') FROM (
            SELECT u.estado::text AS estado, count(*) AS n FROM unidades_imei u WHERE u.producto_id = e.id GROUP BY u.estado
          ) x)
  FROM equipos e
  WHERE EXISTS (SELECT 1 FROM unidades_imei u WHERE u.producto_id = e.id)
    AND NOT EXISTS (SELECT 1 FROM unidades_imei u WHERE u.producto_id = e.id AND u.estado IN ('disponible', 'apartado'))

  UNION ALL
  SELECT 'ALTA', 'Apartado fantasma (el equipo no sale en el catalogo)', p.id, p.nombre, p.tipo, p.precio_venta,
         s.nombre || ': inventario dice ' || i.stock_apartado || ' apartado(s), apartados activos: ' || COALESCE(a.n, 0)
  FROM inventario i
  JOIN productos p ON p.id = i.producto_id AND p.activo = true
  JOIN sucursales s ON s.id = i.sucursal_id
  LEFT JOIN apartados_activos a ON a.producto_id = i.producto_id AND a.sucursal_id = i.sucursal_id
  WHERE i.stock_apartado <> COALESCE(a.n, 0)

  -- ── MEDIA ───────────────────────────────────────────────────────────────
  UNION ALL
  SELECT 'MEDIA', 'Usado sin bateria capturada', e.id, e.nombre, e.tipo, e.precio_venta,
         CASE WHEN b.producto_id IS NULL THEN 'no tiene ninguna unidad registrada'
              WHEN b.con_condicion = 0 THEN 'sus unidades no tienen condicion'
              ELSE 'la condicion no trae un % de bateria: ' || b.condiciones END
  FROM equipos e
  LEFT JOIN bateria b ON b.producto_id = e.id
  WHERE e.tipo = 'usado' AND COALESCE(b.con_salud, 0) = 0

  UNION ALL
  SELECT 'MEDIA', 'Bateria fuera de rango (mas de 100%)', e.id, e.nombre, e.tipo, e.precio_venta,
         'condicion: ' || b.condiciones
  FROM equipos e JOIN bateria b ON b.producto_id = e.id
  WHERE e.tipo = 'usado' AND b.salud_max > 100

  UNION ALL
  SELECT 'MEDIA', 'Unidades del mismo producto con bateria distinta', e.id, e.nombre, e.tipo, e.precio_venta,
         'baterias entre ' || b.salud_min || '% y ' || b.salud_max || '% (el catalogo solo informa una)'
  FROM equipos e JOIN bateria b ON b.producto_id = e.id
  WHERE e.tipo = 'usado' AND b.saludes_distintas > 1

  UNION ALL
  SELECT 'MEDIA', 'Precio atipico contra el mismo modelo', e.id, e.nombre, e.tipo, e.precio_venta,
         'precio $' || e.precio_venta || ' vs mediana $' || round(m.mediana) || ' de ' || m.n || ' iguales'
  FROM equipos e
  JOIN por_modelo m ON m.nombre_norm = e.nombre_norm
  CROSS JOIN umbrales u
  WHERE e.precio_venta > 0 AND m.n >= u.min_del_modelo
    AND (e.precio_venta < m.mediana * u.factor_bajo OR e.precio_venta > m.mediana * u.factor_alto)

  UNION ALL
  SELECT 'MEDIA', 'Precio de celular muy bajo (posible refaccion)', e.id, e.nombre, e.tipo, e.precio_venta,
         'menos de $' || u.precio_minimo
  FROM equipos e CROSS JOIN umbrales u
  WHERE e.precio_venta > 0 AND e.precio_venta < u.precio_minimo
    AND e.nombre_norm !~ '(AIRPODS|WATCH|BAND|RING|FREE ?BUDS|CARGADOR|FUNDA)'

  -- ── BAJA ────────────────────────────────────────────────────────────────
  UNION ALL
  SELECT 'BAJA', 'Sin estatus en el nombre (LIBRE, MDM, AT&T...)', e.id, e.nombre, e.tipo, e.precio_venta,
         'el cliente no puede saber si es libre'
  FROM equipos e JOIN estatus s ON s.id = e.id
  WHERE cardinality(s.lista) = 0
    AND e.nombre_norm !~ '(IPAD|MACBOOK|WATCH|AIRPODS|LAPTOP|TABLET|(^|[^A-Z0-9])TAB([^A-Z0-9]|$)|BAND|RING)'

  UNION ALL
  SELECT 'BAJA', 'Sin color', e.id, e.nombre, e.tipo, e.precio_venta, 'columna color vacia'
  FROM equipos e
  WHERE COALESCE(btrim(e.color), '') = ''

  UNION ALL
  SELECT 'BAJA', 'Sin almacenamiento reconocible', e.id, e.nombre, e.tipo, e.precio_venta,
         'ni la columna ni el nombre traen GB/TB'
  FROM equipos e
  WHERE COALESCE(e.almacenamiento, '') !~* '[0-9]\s?(GB|TB)'
    AND e.nombre_norm !~ '[0-9]{1,4}\s?(GB|TB)'
    AND e.nombre_norm !~ '(AIRPODS|WATCH|BAND|RING|FREE ?BUDS)'

  UNION ALL
  SELECT 'BAJA', 'Marca no reconocible', e.id, e.nombre, e.tipo, e.precio_venta,
         'sin marca capturada y el nombre no dice de que marca es'
  FROM equipos e
  WHERE COALESCE(btrim(e.marca), '') = ''
    AND e.nombre_norm !~ '(IPHONE|IPAD|IWATCH|MACBOOK|AIRPODS|APPLE|SAMSUNG|XIAOMI|REDMI|POCO|HUAWEI|MOTOROLA|MOTO |GOOGLE|PIXEL|LENOVO|OURA|UMIIO|OPPO|REALME|HONOR|ZTE|TCL|NOKIA|VIVO|ONEPLUS)'
    AND NOT (e.nombre_norm ~ '(^|[^0-9])1[1-7]([^0-9]|$)' AND e.nombre_norm ~ '(PRO|PLUS|MINI|MAX|AIR)')

  UNION ALL
  SELECT 'BAJA', 'Sin imagen', e.id, e.nombre, e.tipo, e.precio_venta, 'imagen_url vacia'
  FROM equipos e
  WHERE COALESCE(btrim(e.imagen_url), '') = ''
)
-- ── SELECT FINAL: RESUMEN ────────────────────────────────────────────────────
SELECT severidad, problema, count(*) AS cuantos
FROM problemas
GROUP BY severidad, problema
ORDER BY CASE severidad WHEN 'ALTA' THEN 1 WHEN 'MEDIA' THEN 2 ELSE 3 END, problema;

-- ── PARA VER LOS PRODUCTOS ───────────────────────────────────────────────────
-- Sustituye el SELECT final de arriba (el del resumen) por UNO de estos dos:
--
-- (a) Detalle de TODOS los problemas, ordenado por gravedad:
--
-- SELECT p.severidad, p.problema, count(*) OVER (PARTITION BY p.problema) AS total_del_problema,
--        p.id AS producto_id, p.nombre, p.tipo, p.precio_venta, p.detalle
-- FROM problemas p
-- ORDER BY CASE p.severidad WHEN 'ALTA' THEN 1 WHEN 'MEDIA' THEN 2 ELSE 3 END, p.problema, p.nombre;
--
-- (b) Detalle de UN problema (escribe el nombre tal cual sale en el resumen):
--
-- SELECT p.id AS producto_id, p.nombre, p.tipo, p.precio_venta, p.detalle
-- FROM problemas p
-- WHERE p.problema = 'Usado sin bateria capturada'
-- ORDER BY p.nombre;
