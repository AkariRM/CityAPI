const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { obtenerConfiguracionTicket } = require('../utils/configuracionTicket');
const { inicioDiaUTC, finDiaUTCExclusivo, hoyLocal } = require('../utils/fechas');

const router = express.Router();

router.use(requireAuth, requireRole('admin', 'vendedor'));

const METODOS_VALIDOS = ['efectivo', 'tarjeta', 'credito'];

// Total de ventas de un dia, sin costos ni utilidad — a diferencia de
// /finanzas/resumen (solo admin), esto lo puede ver tambien el vendedor
// para su propio resumen del dia en el dashboard de mostrador.
router.get('/resumen-dia', async (req, res) => {
  const { sucursal_id, fecha } = req.query;
  if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id es requerido.' });
  const dia = fecha || hoyLocal();

  const { rows } = await pool.query(
    `SELECT COALESCE(sum(total), 0) AS total, count(*)::int AS cantidad
     FROM ventas
     WHERE sucursal_id = $1 AND estado = 'completada'
       AND created_at >= $2::timestamptz AND created_at < $3::timestamptz`,
    [sucursal_id, inicioDiaUTC(dia), finDiaUTCExclusivo(dia)]
  );
  res.json({ fecha: dia, total: Number(rows[0].total), cantidad: rows[0].cantidad });
});

// Para la grafica de ventas del Dashboard: un total por dia dentro de un
// rango. Solo trae los dias que sí tuvieron ventas — el llamador rellena
// con $0 los dias sin movimiento. El offset fijo de -6h (mismo que
// inicioDiaUTC/finDiaUTCExclusivo) convierte cada created_at a su dia
// calendario local de Sahuayo antes de agrupar.
router.get('/resumen-rango', async (req, res) => {
  const { sucursal_id, desde, hasta } = req.query;
  if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id es requerido.' });
  if (!desde || !hasta) return res.status(400).json({ error: 'desde y hasta son requeridos (YYYY-MM-DD).' });

  const { rows } = await pool.query(
    `SELECT (date_trunc('day', created_at - interval '6 hours'))::date::text AS dia,
            COALESCE(sum(total), 0) AS total, count(*)::int AS cantidad
     FROM ventas
     WHERE sucursal_id = $1 AND estado = 'completada'
       AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
     GROUP BY dia
     ORDER BY dia`,
    [sucursal_id, inicioDiaUTC(desde), finDiaUTCExclusivo(hasta)]
  );
  res.json(rows.map((r) => ({ fecha: r.dia, total: Number(r.total), cantidad: r.cantidad })));
});

// Sin folio ni filtros de historial: navegar las ventas de los ultimos 7
// dias de una sucursal (usado por Cambios/devoluciones para elegir la venta
// sin teclear el folio). Con desde/hasta/vendedor_id: historial completo
// (usado por la pantalla de Historial de ventas), restringido por rol — un
// vendedor solo puede ver su propio historial, el admin puede ver el de
// cualquiera o el de todos.
router.get('/', async (req, res) => {
  const { folio, sucursal_id, desde, hasta, vendedor_id } = req.query;

  if (folio) {
    const { rows } = await pool.query(
      `SELECT v.id, v.folio, v.sucursal_id, v.subtotal, v.descuento, v.total, v.metodo_pago, v.estado, v.created_at,
              c.nombre AS cliente_nombre
       FROM ventas v
       LEFT JOIN clientes c ON c.id = v.cliente_id
       WHERE v.folio ILIKE '%' || $1 || '%'
       ORDER BY v.created_at DESC
       LIMIT 10`,
      [folio]
    );
    return res.json(rows);
  }

  if (!sucursal_id) return res.status(400).json({ error: 'folio o sucursal_id son requeridos.' });

  const esHistorial = Boolean(desde || hasta || vendedor_id);
  if (!esHistorial) {
    const { rows } = await pool.query(
      `SELECT v.id, v.folio, v.sucursal_id, v.subtotal, v.descuento, v.total, v.metodo_pago, v.estado, v.created_at,
              c.nombre AS cliente_nombre
       FROM ventas v
       LEFT JOIN clientes c ON c.id = v.cliente_id
       WHERE v.sucursal_id = $1 AND v.estado = 'completada' AND v.created_at >= now() - interval '7 days'
       ORDER BY v.created_at DESC
       LIMIT 50`,
      [sucursal_id]
    );
    return res.json(rows);
  }

  const vendedorFiltro = req.usuario.rol === 'vendedor' ? req.usuario.sub : vendedor_id || null;

  const { rows } = await pool.query(
    `SELECT v.id, v.folio, v.sucursal_id, v.vendedor_id, u.nombre AS vendedor_nombre,
            v.subtotal, v.descuento, v.total, v.metodo_pago, v.estado, v.created_at,
            c.nombre AS cliente_nombre
     FROM ventas v
     LEFT JOIN clientes c ON c.id = v.cliente_id
     LEFT JOIN usuarios u ON u.id = v.vendedor_id
     WHERE v.sucursal_id = $1 AND v.estado = 'completada'
       AND ($2::uuid IS NULL OR v.vendedor_id = $2::uuid)
       AND ($3::timestamptz IS NULL OR v.created_at >= $3::timestamptz)
       AND ($4::timestamptz IS NULL OR v.created_at < $4::timestamptz)
     ORDER BY v.created_at DESC
     LIMIT 500`,
    [sucursal_id, vendedorFiltro, desde ? inicioDiaUTC(desde) : null, hasta ? finDiaUTCExclusivo(hasta) : null]
  );
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const ventaResult = await pool.query(
    `SELECT v.id, v.folio, v.sucursal_id, v.subtotal, v.descuento, v.total, v.metodo_pago, v.estado, v.created_at,
            c.nombre AS cliente_nombre
     FROM ventas v LEFT JOIN clientes c ON c.id = v.cliente_id
     WHERE v.id = $1`,
    [req.params.id]
  );
  const venta = ventaResult.rows[0];
  if (!venta) return res.status(404).json({ error: 'Venta no encontrada.' });

  const items = await pool.query(
    `SELECT vi.id, vi.producto_id, p.nombre AS producto_nombre, vi.unidad_imei_id, vi.cantidad, vi.precio_unitario, vi.subtotal
     FROM venta_items vi JOIN productos p ON p.id = vi.producto_id
     WHERE vi.venta_id = $1
     ORDER BY p.nombre`,
    [req.params.id]
  );

  res.json({ ...venta, items: items.rows });
});

router.post('/', async (req, res) => {
  const { sucursal_id, cliente_id, metodo_pago, items, limite_aprobado, condiciones } = req.body ?? {};

  if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id es requerido.' });
  if (!METODOS_VALIDOS.includes(metodo_pago)) return res.status(400).json({ error: 'Método de pago inválido.' });
  if (metodo_pago === 'credito') {
    // La autorizacion de credito (limite y condiciones) es responsabilidad
    // del Admin — un vendedor no puede abrir un credito por su cuenta.
    if (req.usuario.rol !== 'admin') return res.status(403).json({ error: 'Solo un administrador puede autorizar una venta a crédito.' });
    if (!cliente_id) return res.status(400).json({ error: 'Una venta a crédito necesita un cliente.' });
  }
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'La venta necesita al menos un producto.' });
  for (const item of items) {
    if (!item.producto_id || !(item.cantidad > 0)) {
      return res.status(400).json({ error: 'Cada producto necesita producto_id y cantidad válidos.' });
    }
    if (item.descuento !== undefined && !(Number(item.descuento) >= 0)) {
      return res.status(400).json({ error: 'El descuento de cada producto debe ser mayor o igual a 0.' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const tipos = {};
    const nombres = {};
    const precios = {};
    for (const item of items) {
      // El precio se toma siempre del catálogo (con precio especial del
      // cliente o del rol del vendedor ya resuelto), nunca de lo que mande
      // el cliente — de lo contrario cualquiera con el token de un vendedor
      // podría cobrar lo que quisiera por una venta.
      const producto = await client.query(
        `SELECT p.tipo, p.nombre,
                COALESCE(pe_cliente.precio, pe_rol.precio, p.precio_venta) AS precio_venta
         FROM productos p
         LEFT JOIN precios_especiales pe_cliente ON pe_cliente.producto_id = p.id AND pe_cliente.cliente_id = $2::uuid
         LEFT JOIN precios_especiales pe_rol ON pe_rol.producto_id = p.id AND pe_rol.rol = $3::rol_usuario
         WHERE p.id = $1`,
        [item.producto_id, cliente_id || null, req.usuario.rol]
      );
      if (!producto.rows[0]) throw Object.assign(new Error('Producto no encontrado.'), { statusCode: 400 });
      tipos[item.producto_id] = producto.rows[0].tipo;
      nombres[item.producto_id] = producto.rows[0].nombre;
      precios[item.producto_id] = Number(producto.rows[0].precio_venta);

      const itemDescuento = Number(item.descuento) || 0;
      if (itemDescuento > item.cantidad * precios[item.producto_id]) {
        throw Object.assign(new Error(`El descuento de "${producto.rows[0].nombre}" no puede ser mayor a su subtotal.`), { statusCode: 400 });
      }

      if (producto.rows[0].tipo === 'servicio') continue; // los servicios no manejan inventario

      const { rows } = await client.query(
        `SELECT stock_cantidad FROM inventario WHERE producto_id = $1 AND sucursal_id = $2 FOR UPDATE`,
        [item.producto_id, sucursal_id]
      );
      const stockRow = rows[0];
      if (!stockRow || stockRow.stock_cantidad < item.cantidad) {
        throw Object.assign(new Error(`Stock insuficiente para "${producto.rows[0].nombre}".`), { statusCode: 409 });
      }

      if (item.unidad_imei_id) {
        // Una unidad serializada se vende de una en una — nunca en cantidad.
        if (item.cantidad !== 1) {
          throw Object.assign(new Error(`"${producto.rows[0].nombre}" con IMEI solo puede venderse de 1 en 1.`), { statusCode: 400 });
        }
        const unidad = await client.query(
          `SELECT estado FROM unidades_imei WHERE id = $1 AND producto_id = $2 AND sucursal_id = $3 FOR UPDATE`,
          [item.unidad_imei_id, item.producto_id, sucursal_id]
        );
        if (!unidad.rows[0]) throw Object.assign(new Error('La unidad IMEI seleccionada no existe.'), { statusCode: 400 });
        if (unidad.rows[0].estado !== 'disponible') {
          throw Object.assign(new Error(`Esa unidad de "${producto.rows[0].nombre}" ya no está disponible.`), { statusCode: 409 });
        }
      }
    }

    const subtotal = items.reduce((sum, i) => sum + i.cantidad * precios[i.producto_id], 0);
    const descuentoSolicitado = Number(req.body.descuento) || 0;
    if (descuentoSolicitado < 0 || descuentoSolicitado > subtotal) {
      throw Object.assign(new Error('El descuento debe ser mayor o igual a 0 y no puede superar el subtotal.'), { statusCode: 400 });
    }
    const descuento = descuentoSolicitado;
    const total = subtotal - descuento;

    const ventaResult = await client.query(
      `INSERT INTO ventas (sucursal_id, vendedor_id, cliente_id, subtotal, descuento, total, metodo_pago)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, folio, created_at`,
      [sucursal_id, req.usuario.sub, cliente_id || null, subtotal, descuento, total, metodo_pago]
    );
    const venta = ventaResult.rows[0];

    for (const item of items) {
      const precioUnitario = precios[item.producto_id];
      const itemDescuento = Number(item.descuento) || 0;
      const itemSubtotal = item.cantidad * precioUnitario - itemDescuento;
      await client.query(
        `INSERT INTO venta_items (venta_id, producto_id, unidad_imei_id, cantidad, precio_unitario, descuento, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [venta.id, item.producto_id, item.unidad_imei_id || null, item.cantidad, precioUnitario, itemDescuento, itemSubtotal]
      );

      if (item.unidad_imei_id) {
        await client.query(`UPDATE unidades_imei SET estado = 'vendido', updated_at = now() WHERE id = $1`, [item.unidad_imei_id]);
      }

      if (tipos[item.producto_id] === 'servicio') continue;

      await client.query(
        `UPDATE inventario SET stock_cantidad = stock_cantidad - $1, updated_at = now()
         WHERE producto_id = $2 AND sucursal_id = $3`,
        [item.cantidad, item.producto_id, sucursal_id]
      );

      await client.query(
        `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
         VALUES ($1, $2, 'salida', $3, 'Venta de mostrador', 'venta', $4, $5)`,
        [item.producto_id, sucursal_id, item.cantidad, venta.id, req.usuario.sub]
      );
    }

    let credito = null;
    if (metodo_pago === 'credito') {
      const creditoResult = await client.query(
        `INSERT INTO creditos (cliente_id, venta_id, monto_total, saldo_pendiente, autorizado_por, limite_aprobado, condiciones)
         VALUES ($1, $2, $3, $3, $4, $5, $6)
         RETURNING id, monto_total, saldo_pendiente, limite_aprobado, condiciones`,
        [cliente_id, venta.id, total, req.usuario.sub, limite_aprobado ?? null, condiciones || null]
      );
      credito = creditoResult.rows[0];
    }

    await client.query('COMMIT');

    const contexto = await client.query(
      `SELECT s.nombre AS sucursal_nombre, s.direccion AS sucursal_direccion, s.telefono AS sucursal_telefono,
              u.nombre AS vendedor_nombre,
              c.nombre AS cliente_nombre
       FROM sucursales s
       LEFT JOIN usuarios u ON u.id = $2
       LEFT JOIN clientes c ON c.id = $3
       WHERE s.id = $1`,
      [sucursal_id, req.usuario.sub, cliente_id || null]
    );
    const configTicket = await obtenerConfiguracionTicket(client);

    res.status(201).json({
      id: venta.id,
      folio: venta.folio,
      subtotal,
      descuento,
      total,
      metodo_pago,
      credito,
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
        subtotal: item.cantidad * precios[item.producto_id] - (Number(item.descuento) || 0),
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
