const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, requireEmpresa } = require('../middleware/auth');
const { obtenerConfiguracionTicketAurea } = require('../utils/configuracionTicketAurea');
const { inicioDiaUTC, finDiaUTCExclusivo } = require('../utils/fechas');

const router = express.Router();
router.use(requireAuth, requireRole('dueño', 'admin', 'pto'), requireEmpresa('aurea'));

const METODOS_VALIDOS = ['efectivo', 'tarjeta', 'credito'];

// Sin filtros: ultimas 200 (atajo de "recientes", igual que CityPhone).
// Con desde/hasta/usuario_id: historial real — pto (rol operativo, igual
// que 'vendedor' en CityPhone) solo ve las suyas; admin/dueño ven todas o
// filtran por usuario_id.
router.get('/', async (req, res) => {
  const { folio, usuario_id, desde, hasta } = req.query;
  const esHistorial = Boolean(desde || hasta || usuario_id);
  const usuarioFiltro = req.usuario.rol === 'pto' ? req.usuario.sub : usuario_id || null;

  const { rows } = await pool.query(
    `SELECT v.id, v.folio, v.usuario_id, u.nombre AS usuario_nombre, v.cliente_id, c.nombre AS cliente_nombre,
            v.metodo_pago, v.subtotal, v.total, v.created_at
     FROM aurea_ventas v
     LEFT JOIN usuarios u ON u.id = v.usuario_id
     LEFT JOIN aurea_clientes c ON c.id = v.cliente_id
     WHERE ($1::text IS NULL OR v.folio ILIKE '%' || $1 || '%')
       AND ($2::uuid IS NULL OR v.usuario_id = $2::uuid)
       AND ($3::timestamptz IS NULL OR v.created_at >= $3::timestamptz)
       AND ($4::timestamptz IS NULL OR v.created_at < $4::timestamptz)
     ORDER BY v.created_at DESC
     LIMIT ${esHistorial ? 500 : 200}`,
    [folio || null, usuarioFiltro, desde ? inicioDiaUTC(desde) : null, hasta ? finDiaUTCExclusivo(hasta) : null]
  );
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const ventaResult = await pool.query(
    `SELECT v.id, v.folio, v.subtotal, v.total, v.metodo_pago, v.created_at,
            c.nombre AS cliente_nombre
     FROM aurea_ventas v LEFT JOIN aurea_clientes c ON c.id = v.cliente_id
     WHERE v.id = $1`,
    [req.params.id]
  );
  const venta = ventaResult.rows[0];
  if (!venta) return res.status(404).json({ error: 'Venta no encontrada.' });

  const items = await pool.query(
    `SELECT vi.id, vi.producto_id, p.nombre AS producto_nombre, vi.cantidad, vi.precio_unitario, vi.subtotal
     FROM aurea_venta_items vi JOIN aurea_productos p ON p.id = vi.producto_id
     WHERE vi.venta_id = $1
     ORDER BY p.nombre`,
    [req.params.id]
  );

  res.json({ ...venta, items: items.rows });
});

router.post('/', async (req, res) => {
  const { cliente_id, metodo_pago, items } = req.body ?? {};
  if (!METODOS_VALIDOS.includes(metodo_pago)) return res.status(400).json({ error: 'Método de pago inválido.' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'La venta necesita al menos un producto.' });
  for (const item of items) {
    if (!item.producto_id || !(item.cantidad > 0)) {
      return res.status(400).json({ error: 'Cada producto necesita producto_id y cantidad válidos.' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const precios = {};
    const nombres = {};
    for (const item of items) {
      const { rows } = await client.query(
        `SELECT nombre, precio_venta, stock_cantidad FROM aurea_productos WHERE id = $1 AND activo = true FOR UPDATE`,
        [item.producto_id]
      );
      const producto = rows[0];
      if (!producto) throw Object.assign(new Error('Producto no encontrado.'), { statusCode: 400 });
      if (producto.stock_cantidad < item.cantidad) {
        throw Object.assign(new Error(`Stock insuficiente para "${producto.nombre}".`), { statusCode: 409 });
      }
      precios[item.producto_id] = Number(producto.precio_venta);
      nombres[item.producto_id] = producto.nombre;
    }

    const subtotal = items.reduce((sum, i) => sum + i.cantidad * precios[i.producto_id], 0);

    const ventaResult = await client.query(
      `INSERT INTO aurea_ventas (usuario_id, cliente_id, metodo_pago, subtotal, total)
       VALUES ($1, $2, $3, $4, $4)
       RETURNING id, folio, subtotal, total, created_at`,
      [req.usuario.sub, cliente_id || null, metodo_pago, subtotal]
    );
    const venta = ventaResult.rows[0];

    for (const item of items) {
      const precioUnitario = precios[item.producto_id];
      const itemSubtotal = item.cantidad * precioUnitario;
      await client.query(
        `INSERT INTO aurea_venta_items (venta_id, producto_id, cantidad, precio_unitario, subtotal)
         VALUES ($1, $2, $3, $4, $5)`,
        [venta.id, item.producto_id, item.cantidad, precioUnitario, itemSubtotal]
      );
      await client.query(
        `UPDATE aurea_productos SET stock_cantidad = stock_cantidad - $1, updated_at = now() WHERE id = $2`,
        [item.cantidad, item.producto_id]
      );
    }

    await client.query('COMMIT');

    const contexto = await client.query(
      `SELECT u.nombre AS vendedor_nombre, c.nombre AS cliente_nombre
       FROM usuarios u LEFT JOIN aurea_clientes c ON c.id = $2
       WHERE u.id = $1`,
      [req.usuario.sub, cliente_id || null]
    );
    const configTicket = await obtenerConfiguracionTicketAurea(client);

    res.status(201).json({
      id: venta.id,
      folio: venta.folio,
      subtotal,
      total: subtotal,
      metodo_pago,
      created_at: venta.created_at,
      ...contexto.rows[0],
      nombre_negocio: configTicket.nombre_negocio,
      mostrar_direccion: configTicket.mostrar_direccion,
      mostrar_telefono: configTicket.mostrar_telefono,
      mostrar_vendedor: configTicket.mostrar_vendedor,
      mostrar_cliente: configTicket.mostrar_cliente,
      mensaje_pie: configTicket.mensaje_pie,
      items: items.map((item) => ({
        producto_id: item.producto_id,
        nombre: nombres[item.producto_id],
        cantidad: item.cantidad,
        precio_unitario: precios[item.producto_id],
        subtotal: item.cantidad * precios[item.producto_id],
      })),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.statusCode ?? 500).json({ error: err.statusCode ? err.message : 'Error interno del servidor.' });
    if (!err.statusCode) console.error(err);
  } finally {
    client.release();
  }
});

module.exports = router;
