const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, esAdminODueno } = require('../middleware/auth');
const { inicioDiaUTC, finDiaUTCExclusivo } = require('../utils/fechas');

const router = express.Router();

router.use(requireAuth);

// El listado tambien lo usa el tecnico para buscar refacciones al armar un
// folio de reparacion, y el community manager para el catalogo de solo
// lectura y para vincular equipos en Marketplace; las demas rutas (alta,
// edicion, stock, IMEI) siguen restringidas a quienes administran el catalogo.
router.get('/', requireRole('admin', 'vendedor', 'tecnico', 'community_manager'), async (req, res) => {
  const { sucursal_id, q, categoria_id, tipo, cliente_id, activo } = req.query;
  // Admin y dueño pueden omitir sucursal_id (ven "Todas las sucursales" con
  // el stock sumado); los demas roles lo siguen necesitando, igual que siempre.
  if (!sucursal_id && !esAdminODueno(req.usuario.rol)) return res.status(400).json({ error: 'sucursal_id es requerido.' });

  const tipos = tipo ? tipo.split(',').map((t) => t.trim()) : null;
  const activoFiltro = activo === undefined ? true : activo === 'true';

  // precio_venta ya viene resuelto (precio especial del cliente > precio
  // especial del rol del usuario que consulta > precio de lista), para que
  // el catálogo del Punto de Venta y el precio cobrado en /ventas coincidan
  // siempre. precio_lista y precio_especial se mandan aparte para poder
  // mostrar en pantalla que un precio es especial.
  const { rows } = await pool.query(
    `SELECT p.id, p.sku, p.nombre, p.tipo, p.marca, p.modelo, p.ram, p.almacenamiento, p.procesador, p.color,
            p.usa_imei, p.activo, p.costo, p.precio_mayoreo, p.precio_revendedor,
            p.precio_venta AS precio_lista,
            COALESCE(pe_cliente.precio, pe_rol.precio, p.precio_venta) AS precio_venta,
            (pe_cliente.precio IS NOT NULL OR pe_rol.precio IS NOT NULL) AS precio_especial,
            p.imagen_url, p.categoria_id, c.nombre AS categoria_nombre,
            p.proveedor_id, pv.nombre AS proveedor_nombre,
            COALESCE(i.stock_cantidad, 0) AS stock, COALESCE(i.stock_minimo, 0) AS stock_minimo,
            COALESCE(i.stock_apartado, 0) AS stock_apartado
     FROM productos p
     LEFT JOIN categorias c ON c.id = p.categoria_id
     LEFT JOIN proveedores pv ON pv.id = p.proveedor_id
     LEFT JOIN LATERAL (
       SELECT SUM(inv.stock_cantidad)::int AS stock_cantidad, SUM(inv.stock_minimo)::int AS stock_minimo, SUM(inv.stock_apartado)::int AS stock_apartado
       FROM inventario inv
       WHERE inv.producto_id = p.id AND ($1::uuid IS NULL OR inv.sucursal_id = $1::uuid)
     ) i ON true
     LEFT JOIN precios_especiales pe_cliente ON pe_cliente.producto_id = p.id AND pe_cliente.cliente_id = $5::uuid
     LEFT JOIN precios_especiales pe_rol ON pe_rol.producto_id = p.id AND pe_rol.rol = $6::rol_usuario
     WHERE p.activo = $7::boolean
       AND ($2::uuid IS NULL OR p.categoria_id = $2::uuid)
       AND ($3::text IS NULL OR p.nombre ILIKE '%' || $3 || '%')
       AND ($4::text[] IS NULL OR p.tipo::text = ANY($4::text[]))
     ORDER BY p.nombre`,
    [sucursal_id || null, categoria_id || null, q || null, tipos, cliente_id || null, req.usuario.rol, activoFiltro]
  );
  res.json(rows);
});

// Bitacora de entradas/salidas/ajustes de todos los productos de una
// sucursal. Va antes de "/:id" para que Express no lo confunda con una
// busqueda por id.
router.get('/movimientos', requireRole('admin', 'vendedor'), async (req, res) => {
  const { sucursal_id, producto_id, desde, hasta } = req.query;
  // Admin y dueño pueden omitir sucursal_id (ven el historial combinado de
  // todas las sucursales); vendedor lo sigue necesitando, igual que siempre.
  if (!sucursal_id && !esAdminODueno(req.usuario.rol)) return res.status(400).json({ error: 'sucursal_id es requerido.' });

  const { rows } = await pool.query(
    `SELECT m.id, m.producto_id, p.nombre AS producto_nombre, m.tipo, m.cantidad, m.motivo,
            m.referencia_tipo, m.referencia_id, m.usuario_id, u.nombre AS usuario_nombre, m.created_at
     FROM movimientos_inventario m
     JOIN productos p ON p.id = m.producto_id
     LEFT JOIN usuarios u ON u.id = m.usuario_id
     WHERE ($1::uuid IS NULL OR m.sucursal_id = $1::uuid)
       AND ($2::uuid IS NULL OR m.producto_id = $2::uuid)
       AND ($3::timestamptz IS NULL OR m.created_at >= $3::timestamptz)
       AND ($4::timestamptz IS NULL OR m.created_at < $4::timestamptz)
     ORDER BY m.created_at DESC
     LIMIT 200`,
    [sucursal_id || null, producto_id || null, desde ? inicioDiaUTC(desde) : null, hasta ? finDiaUTCExclusivo(hasta) : null]
  );
  res.json(rows);
});

// Exporta el catalogo como CSV para compartir con terceros (ej. la agencia
// que arma las automatizaciones de marketing) como referencia de datos
// reales — deliberadamente excluye costo/precio_mayoreo/precio_revendedor/
// proveedor/stock, que son datos internos del negocio, no algo para salir
// de la empresa.
router.get('/export', requireRole('admin', 'vendedor', 'community_manager'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.sku, p.nombre, p.tipo, c.nombre AS categoria, p.marca, p.modelo, p.precio_venta, p.imagen_url
     FROM productos p
     LEFT JOIN categorias c ON c.id = p.categoria_id
     WHERE p.activo = true
     ORDER BY p.nombre`
  );

  function csvCampo(valor) {
    const texto = valor === null || valor === undefined ? '' : String(valor);
    return /[",\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
  }

  const encabezado = ['sku', 'nombre', 'tipo', 'categoria', 'marca', 'modelo', 'precio_venta', 'imagen_url'];
  const lineas = rows.map((r) => encabezado.map((campo) => csvCampo(r[campo])).join(','));
  const csv = '﻿' + [encabezado.join(','), ...lineas].join('\r\n');

  const fecha = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="catalogo-cityphone-${fecha}.csv"`);
  res.send(csv);
});

router.post('/', requireRole('admin', 'vendedor'), async (req, res) => {
  const {
    sku, nombre, categoria_id, tipo, marca, modelo, ram, almacenamiento, procesador, color, usa_imei,
    precio_venta, costo, precio_mayoreo, precio_revendedor, imagen_url, proveedor_id, sucursal_id, stock_inicial,
  } = req.body ?? {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido.' });
  if (!['nuevo', 'usado', 'accesorio', 'servicio'].includes(tipo)) {
    return res.status(400).json({ error: 'Tipo inválido.' });
  }

  const cantidad = Number(stock_inicial) || 0;
  if (sucursal_id && cantidad < 0) return res.status(400).json({ error: 'La cantidad inicial no puede ser negativa.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const producto = await client.query(
      `INSERT INTO productos (sku, nombre, categoria_id, tipo, marca, modelo, ram, almacenamiento, procesador, color, usa_imei, precio_venta, costo, precio_mayoreo, precio_revendedor, imagen_url, proveedor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING id, sku, nombre, categoria_id, tipo, marca, modelo, ram, almacenamiento, procesador, color, usa_imei, precio_venta, costo, precio_mayoreo, precio_revendedor, imagen_url, proveedor_id, activo`,
      [
        sku || null, nombre.trim(), categoria_id || null, tipo, marca || null, modelo || null,
        ram || null, almacenamiento || null, procesador || null, color || null, usa_imei === false ? false : true,
        precio_venta ?? 0, costo ?? 0, precio_mayoreo ?? null, precio_revendedor ?? null, imagen_url || null, proveedor_id || null,
      ]
    );

    if (sucursal_id) {
      await client.query(
        `INSERT INTO inventario (producto_id, sucursal_id, stock_cantidad) VALUES ($1, $2, $3)`,
        [producto.rows[0].id, sucursal_id, cantidad]
      );
      if (cantidad > 0) {
        await client.query(
          `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
           VALUES ($1, $2, 'entrada', $3, 'Alta de producto con stock inicial', 'producto', $1, $4)`,
          [producto.rows[0].id, sucursal_id, cantidad, req.usuario.sub]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ ...producto.rows[0], stock: cantidad });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  } finally {
    client.release();
  }
});

router.patch('/:id', requireRole('admin', 'vendedor'), async (req, res) => {
  if (req.body?.tipo !== undefined && !['nuevo', 'usado', 'accesorio', 'servicio'].includes(req.body.tipo)) {
    return res.status(400).json({ error: 'Tipo inválido.' });
  }
  const fields = {
    nombre: req.body?.nombre,
    tipo: req.body?.tipo,
    categoria_id: req.body?.categoria_id,
    precio_venta: req.body?.precio_venta,
    costo: req.body?.costo,
    precio_mayoreo: req.body?.precio_mayoreo,
    precio_revendedor: req.body?.precio_revendedor,
    marca: req.body?.marca,
    modelo: req.body?.modelo,
    ram: req.body?.ram,
    almacenamiento: req.body?.almacenamiento,
    procesador: req.body?.procesador,
    color: req.body?.color,
    usa_imei: req.body?.usa_imei,
    proveedor_id: req.body?.proveedor_id,
    imagen_url: req.body?.imagen_url,
    activo: req.body?.activo,
  };
  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      sets.push(`${key} = $${i++}`);
      values.push(value);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: 'No hay campos para actualizar.' });

  values.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE productos SET ${sets.join(', ')} WHERE id = $${i}
     RETURNING id, sku, nombre, categoria_id, tipo, marca, modelo, ram, almacenamiento, procesador, color, usa_imei, precio_venta, costo, precio_mayoreo, precio_revendedor, imagen_url, proveedor_id, activo`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Producto no encontrado.' });
  res.json(rows[0]);
});

router.patch('/:id/stock-minimo', requireRole('admin', 'vendedor'), async (req, res) => {
  const { sucursal_id, stock_minimo } = req.body ?? {};
  if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id es requerido.' });
  if (!(Number.isInteger(stock_minimo) && stock_minimo >= 0)) {
    return res.status(400).json({ error: 'stock_minimo debe ser un entero mayor o igual a 0.' });
  }

  const { rows } = await pool.query(
    `INSERT INTO inventario (producto_id, sucursal_id, stock_cantidad, stock_minimo)
     VALUES ($1, $2, 0, $3)
     ON CONFLICT (producto_id, sucursal_id) DO UPDATE SET stock_minimo = $3, updated_at = now()
     RETURNING stock_cantidad, stock_minimo`,
    [req.params.id, sucursal_id, stock_minimo]
  );
  res.json(rows[0]);
});

router.post('/:id/ajuste-stock', requireRole('admin', 'vendedor'), async (req, res) => {
  const { sucursal_id, cantidad, motivo, tipo } = req.body ?? {};
  if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id es requerido.' });
  const delta = Number(cantidad);
  if (!delta) return res.status(400).json({ error: 'cantidad debe ser distinta de 0.' });
  if (tipo !== undefined && !['entrada', 'salida', 'ajuste'].includes(tipo)) {
    return res.status(400).json({ error: 'tipo inválido.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (delta < 0) {
      const { rows } = await client.query(
        `SELECT stock_cantidad FROM inventario WHERE producto_id = $1 AND sucursal_id = $2 FOR UPDATE`,
        [req.params.id, sucursal_id]
      );
      if (!rows[0] || rows[0].stock_cantidad + delta < 0) {
        throw Object.assign(new Error('No hay stock suficiente para ese ajuste.'), { statusCode: 409 });
      }
    }

    const result = await client.query(
      `INSERT INTO inventario (producto_id, sucursal_id, stock_cantidad)
       VALUES ($1, $2, GREATEST($3, 0))
       ON CONFLICT (producto_id, sucursal_id) DO UPDATE SET stock_cantidad = inventario.stock_cantidad + $3, updated_at = now()
       RETURNING stock_cantidad`,
      [req.params.id, sucursal_id, delta]
    );

    await client.query(
      `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, motivo, referencia_tipo, usuario_id)
       VALUES ($1, $2, $3, $4, $5, 'ajuste', $6)`,
      [req.params.id, sucursal_id, tipo || (delta > 0 ? 'entrada' : 'salida'), Math.abs(delta), motivo || 'Ajuste manual de inventario', req.usuario.sub]
    );

    await client.query('COMMIT');
    res.json({ stock: result.rows[0].stock_cantidad });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.statusCode ?? 500).json({ error: err.statusCode ? err.message : 'Error interno del servidor.' });
    if (!err.statusCode) console.error(err);
  } finally {
    client.release();
  }
});

router.get('/:id/unidades', requireRole('admin', 'vendedor'), async (req, res) => {
  const { sucursal_id } = req.query;
  const { rows } = await pool.query(
    `SELECT id, imei, condicion, costo_adquisicion, estado, created_at
     FROM unidades_imei
     WHERE producto_id = $1 AND estado != 'baja' AND ($2::uuid IS NULL OR sucursal_id = $2::uuid)
     ORDER BY created_at DESC`,
    [req.params.id, sucursal_id || null]
  );
  res.json(rows);
});

router.post('/:id/unidades', requireRole('admin', 'vendedor'), async (req, res) => {
  const { sucursal_id, imei, condicion, costo_adquisicion } = req.body ?? {};
  if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id es requerido.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const unidad = await client.query(
      `INSERT INTO unidades_imei (producto_id, sucursal_id, imei, condicion, costo_adquisicion)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, imei, condicion, costo_adquisicion, estado, created_at`,
      [req.params.id, sucursal_id, imei?.trim() || null, condicion || null, costo_adquisicion || null]
    );

    await client.query(
      `INSERT INTO inventario (producto_id, sucursal_id, stock_cantidad)
       VALUES ($1, $2, 1)
       ON CONFLICT (producto_id, sucursal_id) DO UPDATE SET stock_cantidad = inventario.stock_cantidad + 1, updated_at = now()`,
      [req.params.id, sucursal_id]
    );

    await client.query(
      `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
       VALUES ($1, $2, 'entrada', 1, 'Alta de equipo con IMEI', 'unidad_imei', $3, $4)`,
      [req.params.id, sucursal_id, unidad.rows[0].id, req.usuario.sub]
    );

    await client.query('COMMIT');
    res.status(201).json(unidad.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      res.status(409).json({ error: 'Ese IMEI ya está registrado.' });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Error interno del servidor.' });
    }
  } finally {
    client.release();
  }
});

router.delete('/:id/unidades/:unidadId', requireRole('admin', 'vendedor'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT id, sucursal_id, estado FROM unidades_imei WHERE id = $1 AND producto_id = $2 FOR UPDATE`,
      [req.params.unidadId, req.params.id]
    );
    const unidad = rows[0];
    if (!unidad) throw Object.assign(new Error('Unidad no encontrada.'), { statusCode: 404 });
    if (unidad.estado === 'baja') {
      throw Object.assign(new Error('Esa unidad ya fue eliminada.'), { statusCode: 409 });
    }

    const venta = await client.query(`SELECT 1 FROM venta_items WHERE unidad_imei_id = $1 LIMIT 1`, [unidad.id]);
    if (venta.rows.length > 0) {
      throw Object.assign(new Error('No se puede eliminar una unidad ya vendida.'), { statusCode: 409 });
    }

    await client.query(`UPDATE unidades_imei SET estado = 'baja', updated_at = now() WHERE id = $1`, [unidad.id]);

    await client.query(
      `UPDATE inventario SET stock_cantidad = GREATEST(stock_cantidad - 1, 0), updated_at = now()
       WHERE producto_id = $1 AND sucursal_id = $2`,
      [req.params.id, unidad.sucursal_id]
    );

    await client.query(
      `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
       VALUES ($1, $2, 'salida', 1, 'Baja de unidad IMEI', 'unidad_imei', $3, $4)`,
      [req.params.id, unidad.sucursal_id, unidad.id, req.usuario.sub]
    );

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.statusCode ?? 500).json({ error: err.statusCode ? err.message : 'Error interno del servidor.' });
    if (!err.statusCode) console.error(err);
  } finally {
    client.release();
  }
});

const MAX_IMAGENES_PRODUCTO = 10;

router.get('/:id/imagenes', requireRole('admin', 'vendedor', 'tecnico', 'community_manager'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, imagen_url, es_principal, orden, created_at
     FROM producto_imagenes WHERE producto_id = $1 ORDER BY orden ASC, created_at ASC`,
    [req.params.id]
  );
  res.json(rows);
});

// La primera imagen que se sube a un producto queda como principal
// automaticamente — el cliente no elige eso aqui, es un PATCH aparte
// (.../principal) para cambiarla despues. "orden" es simplemente el conteo
// actual, asi que cada imagen nueva se agrega al final.
router.post('/:id/imagenes', requireRole('admin', 'vendedor'), async (req, res) => {
  const { imagen_url } = req.body ?? {};
  if (!imagen_url) return res.status(400).json({ error: 'imagen_url es requerida.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const actuales = await client.query(
      `SELECT count(*)::int AS total FROM producto_imagenes WHERE producto_id = $1`,
      [req.params.id]
    );
    const total = actuales.rows[0].total;
    if (total >= MAX_IMAGENES_PRODUCTO) {
      throw Object.assign(new Error(`Un producto no puede tener más de ${MAX_IMAGENES_PRODUCTO} imágenes.`), { statusCode: 400 });
    }
    const esPrincipal = total === 0;

    const { rows } = await client.query(
      `INSERT INTO producto_imagenes (producto_id, imagen_url, es_principal, orden)
       VALUES ($1, $2, $3, $4)
       RETURNING id, imagen_url, es_principal, orden, created_at`,
      [req.params.id, imagen_url, esPrincipal, total]
    );

    if (esPrincipal) {
      await client.query(`UPDATE productos SET imagen_url = $1, updated_at = now() WHERE id = $2`, [imagen_url, req.params.id]);
    }

    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.statusCode ?? 500).json({ error: err.statusCode ? err.message : 'Error interno del servidor.' });
    if (!err.statusCode) console.error(err);
  } finally {
    client.release();
  }
});

router.patch('/:id/imagenes/:imagenId/principal', requireRole('admin', 'vendedor'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT imagen_url FROM producto_imagenes WHERE id = $1 AND producto_id = $2`,
      [req.params.imagenId, req.params.id]
    );
    if (!rows[0]) throw Object.assign(new Error('Imagen no encontrada.'), { statusCode: 404 });

    await client.query(`UPDATE producto_imagenes SET es_principal = false WHERE producto_id = $1`, [req.params.id]);
    await client.query(`UPDATE producto_imagenes SET es_principal = true WHERE id = $1`, [req.params.imagenId]);
    await client.query(`UPDATE productos SET imagen_url = $1, updated_at = now() WHERE id = $2`, [rows[0].imagen_url, req.params.id]);

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.statusCode ?? 500).json({ error: err.statusCode ? err.message : 'Error interno del servidor.' });
    if (!err.statusCode) console.error(err);
  } finally {
    client.release();
  }
});

// Si la imagen borrada era la principal, la siguiente por orden la
// sustituye automaticamente — un producto con al menos una imagen siempre
// tiene exactamente una principal. Si era la unica, imagen_url queda null.
router.delete('/:id/imagenes/:imagenId', requireRole('admin', 'vendedor'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `DELETE FROM producto_imagenes WHERE id = $1 AND producto_id = $2 RETURNING es_principal`,
      [req.params.imagenId, req.params.id]
    );
    if (!rows[0]) throw Object.assign(new Error('Imagen no encontrada.'), { statusCode: 404 });

    if (rows[0].es_principal) {
      const siguiente = await client.query(
        `SELECT id, imagen_url FROM producto_imagenes WHERE producto_id = $1 ORDER BY orden ASC, created_at ASC LIMIT 1`,
        [req.params.id]
      );
      if (siguiente.rows[0]) {
        await client.query(`UPDATE producto_imagenes SET es_principal = true WHERE id = $1`, [siguiente.rows[0].id]);
        await client.query(`UPDATE productos SET imagen_url = $1, updated_at = now() WHERE id = $2`, [siguiente.rows[0].imagen_url, req.params.id]);
      } else {
        await client.query(`UPDATE productos SET imagen_url = NULL, updated_at = now() WHERE id = $1`, [req.params.id]);
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.statusCode ?? 500).json({ error: err.statusCode ? err.message : 'Error interno del servidor.' });
    if (!err.statusCode) console.error(err);
  } finally {
    client.release();
  }
});

// Importador de inventario desde Excel (CityApp parsea el archivo del lado
// del cliente y manda solo las filas ya interpretadas, en tandas). Cada
// item vive en su propia transaccion — a la escala de un historial de
// compras real (cientos/miles de filas) no tiene sentido que una sola fila
// con problema (ej. IMEI duplicado) tumbe a todas las demas del lote.
router.post('/importar-lote', requireRole('admin', 'vendedor'), async (req, res) => {
  const { sucursal_id, tipo, items } = req.body ?? {};
  if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id es requerido.' });
  if (!['nuevo', 'usado'].includes(tipo)) return res.status(400).json({ error: 'tipo debe ser "nuevo" o "usado".' });
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items debe ser una lista con al menos un elemento.' });
  }

  let creados = 0;
  const fallidos = [];

  for (const item of items) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (!item.nombre?.trim()) throw Object.assign(new Error('Nombre vacío.'), { statusCode: 400 });

      const producto = await client.query(
        `INSERT INTO productos (nombre, descripcion, marca, modelo, color, almacenamiento, tipo, usa_imei, precio_venta, costo, precio_mayoreo, precio_revendedor)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, $10, $11)
         RETURNING id`,
        [
          item.nombre.trim(),
          item.descripcion || null,
          item.marca || null,
          item.modelo || null,
          item.color || null,
          item.almacenamiento || null,
          tipo,
          Number(item.precio_venta) || 0,
          Number(item.costo) || 0,
          item.precio_mayoreo != null ? Number(item.precio_mayoreo) : null,
          item.precio_revendedor != null ? Number(item.precio_revendedor) : null,
        ]
      );
      const productoId = producto.rows[0].id;

      await client.query(
        `INSERT INTO unidades_imei (producto_id, sucursal_id, imei, condicion) VALUES ($1, $2, $3, $4)`,
        [productoId, sucursal_id, item.imei?.trim() || null, item.condicion || null]
      );

      await client.query(
        `INSERT INTO inventario (producto_id, sucursal_id, stock_cantidad)
         VALUES ($1, $2, 1)
         ON CONFLICT (producto_id, sucursal_id) DO UPDATE SET stock_cantidad = inventario.stock_cantidad + 1, updated_at = now()`,
        [productoId, sucursal_id]
      );

      await client.query(
        `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
         VALUES ($1, $2, 'entrada', 1, 'Importado desde Excel', 'producto', $1, $3)`,
        [productoId, sucursal_id, req.usuario.sub]
      );

      await client.query('COMMIT');
      creados += 1;
    } catch (err) {
      await client.query('ROLLBACK');
      const mensaje = err.code === '23505' ? 'Ese IMEI ya está registrado.' : err.message ?? 'Error desconocido.';
      fallidos.push({ fila: item.fila ?? null, nombre: item.nombre ?? null, error: mensaje });
    } finally {
      client.release();
    }
  }

  res.json({ creados, fallidos });
});

module.exports = router;
