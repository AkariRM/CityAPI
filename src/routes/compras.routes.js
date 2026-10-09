const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { obtenerConfiguracionTicket } = require('../utils/configuracionTicket');
const { inicioDiaUTC, finDiaUTCExclusivo } = require('../utils/fechas');
const { TASA_IVA, calcularImporte, planificarRenglon, totalesCompra } = require('../utils/compras');
const { leerCfdi } = require('../utils/facturaCfdi');
const { construirPropuesta, esRfc, sinAcentos } = require('../utils/facturaPropuesta');
const { MAX_BYTES_XML, decodificarArchivo, detectarArchivo, leerFacturaConIA } = require('../utils/facturaIA');

// Compras de inventario: las registra quien recibe y paga, o sea el dueño o el supervisor (requireRole('admin')
// deja pasar al dueño tambien). El vendedor ya no da de alta productos ni toca costos (productos.routes.js).
const router = express.Router();
router.use(requireAuth, requireRole('admin'));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMAS_PAGO = ['efectivo', 'tarjeta', 'transferencia', 'cheque'];
const PRECIOS_MODOS = ['margen', 'mantener'];
const DIRECCIONES = ['arriba', 'abajo', 'cercano'];
// Solo accesorios: los equipos (nuevos y usados) se dan de alta en Equipos nuevos/usados o entran por Cambios.
const TIPO_COMPRABLE = 'accesorio';
const MAX_RENGLONES = 200;

function falla(statusCode, mensaje, extra = {}) {
  return Object.assign(new Error(mensaje), { statusCode, ...extra });
}

function responderError(res, err) {
  if (err.statusCode) return res.status(err.statusCode).json({ error: err.message, ...(err.detalle ? { detalle: err.detalle } : {}) });
  console.error(err);
  return res.status(500).json({ error: 'Error interno del servidor.' });
}

// Un supervisor con sucursal fija solo trabaja la suya; el dueño (o un supervisor sin sucursal) elige.
function sucursalDeTrabajo(req, pedida) {
  const propia = req.usuario.rol === 'admin' ? req.usuario.sucursal_id : null;
  if (propia && pedida && pedida !== propia) throw falla(403, 'Solo puedes trabajar con compras de tu sucursal.');
  return propia || pedida || null;
}

function esFechaValida(texto) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return false;
  const d = new Date(`${texto}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === texto;
}

const esEntero = (n) => Number.isInteger(n);
const esNumero = (n) => typeof n === 'number' && Number.isFinite(n);

// Renglones tal como los manda la pantalla -> renglones normalizados, o 400.
function validarRenglones(items) {
  if (!Array.isArray(items) || items.length === 0) throw falla(400, 'Agrega al menos un producto a la compra.');
  if (items.length > MAX_RENGLONES) throw falla(400, `Una compra admite hasta ${MAX_RENGLONES} productos.`);
  const vistos = new Set();
  return items.map((it, i) => {
    const n = i + 1;
    if (!UUID_RE.test(it?.producto_id ?? '')) throw falla(400, `Renglón ${n}: producto inválido.`);
    if (vistos.has(it.producto_id)) throw falla(400, `Renglón ${n}: ese producto ya está en la compra, edita el renglón existente.`);
    vistos.add(it.producto_id);
    const piezasPorUnidad = it.piezas_por_unidad ?? 1;
    const descuentoPct = it.descuento_pct ?? 0;
    const descuentoMonto = it.descuento_monto ?? 0;
    if (!(esEntero(it.cantidad) && it.cantidad >= 1 && it.cantidad <= 1000000)) throw falla(400, `Renglón ${n}: la cantidad debe ser un entero mayor a 0.`);
    if (!(esEntero(piezasPorUnidad) && piezasPorUnidad >= 1 && piezasPorUnidad <= 100000)) throw falla(400, `Renglón ${n}: las piezas por caja deben ser un entero mayor a 0.`);
    if (!(esNumero(it.costo_unitario) && it.costo_unitario >= 0 && it.costo_unitario <= 100000000)) throw falla(400, `Renglón ${n}: el costo debe ser un número mayor o igual a 0.`);
    if (!(esNumero(descuentoPct) && descuentoPct >= 0 && descuentoPct <= 100)) throw falla(400, `Renglón ${n}: el descuento en % debe estar entre 0 y 100.`);
    if (!(esNumero(descuentoMonto) && descuentoMonto >= 0)) throw falla(400, `Renglón ${n}: el descuento en pesos debe ser 0 o más.`);
    const importe = calcularImporte({ cantidad: it.cantidad, costo_unitario: it.costo_unitario, descuento_pct: descuentoPct, descuento_monto: descuentoMonto });
    if (importe < 0) throw falla(400, `Renglón ${n}: el descuento es mayor que el importe.`);
    const clave = typeof it.clave_proveedor === 'string' ? it.clave_proveedor.trim().slice(0, 60) : '';
    return {
      producto_id: it.producto_id,
      cantidad: it.cantidad,
      piezas_por_unidad: piezasPorUnidad,
      costo_unitario: it.costo_unitario,
      descuento_pct: descuentoPct,
      descuento_monto: descuentoMonto,
      clave_proveedor: clave || null,
      actualizar_precios: it.actualizar_precios !== false,
    };
  });
}

// Modo de precios, redondeo e IVA: lo que mande la compra, y si no, lo configurado.
function normalizarOpciones(body, config) {
  const precios_modo = body.precios_modo ?? config.compras_precios_modo;
  const redondeo_multiplo = body.redondeo_multiplo ?? Number(config.compras_redondeo_multiplo);
  const redondeo_direccion = body.redondeo_direccion ?? config.compras_redondeo_direccion;
  if (!PRECIOS_MODOS.includes(precios_modo)) throw falla(400, "El modo de precios debe ser 'margen' o 'mantener'.");
  if (!(esNumero(redondeo_multiplo) && redondeo_multiplo >= 0 && redondeo_multiplo <= 100000)) throw falla(400, 'El redondeo debe ser un número entre 0 y 100000.');
  if (!DIRECCIONES.includes(redondeo_direccion)) throw falla(400, "La dirección del redondeo debe ser 'arriba', 'abajo' o 'cercano'.");
  return { precios_modo, redondeo_multiplo, redondeo_direccion, iva_tasa: body.incluye_iva === true ? TASA_IVA : 0 };
}

// Estado actual de los productos (con el stock de TODAS las sucursales, porque el costo es del producto).
async function cargarProductos(queryable, ids, { bloquear = false } = {}) {
  if (bloquear) await queryable.query(`SELECT id FROM productos WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [ids]);
  const { rows } = await queryable.query(
    `SELECT p.id, p.nombre, p.sku, p.tipo, p.activo, p.costo, p.precio_venta, p.precio_mayoreo, p.precio_revendedor,
            COALESCE((SELECT sum(stock_cantidad) FROM inventario WHERE producto_id = p.id), 0)::int AS stock_total
     FROM productos p WHERE p.id = ANY($1::uuid[])`,
    [ids]
  );
  return new Map(rows.map((p) => [p.id, p]));
}

function armarPlan(renglones, productos, opciones) {
  return renglones.map((item, i) => {
    const producto = productos.get(item.producto_id);
    const n = i + 1;
    if (!producto) throw falla(400, `Renglón ${n}: el producto no existe.`);
    if (producto.tipo === 'servicio') throw falla(400, `Renglón ${n}: "${producto.nombre}" es un servicio y no maneja inventario.`);
    if (producto.tipo !== TIPO_COMPRABLE) throw falla(400, `Renglón ${n}: "${producto.nombre}" es un equipo. Los equipos se dan de alta en Equipos nuevos/usados o entran por Cambios, no por Compras.`);
    if (!producto.activo) throw falla(400, `Renglón ${n}: "${producto.nombre}" está dado de baja.`);
    return { item, producto, plan: planificarRenglon({ item, producto, ...opciones }) };
  });
}

function resumenRenglon({ item, producto, plan }) {
  return {
    producto_id: producto.id,
    nombre: producto.nombre,
    sku: producto.sku,
    cantidad: item.cantidad,
    piezas_por_unidad: plan.piezas_por_unidad,
    piezas: plan.piezas,
    costo_unitario: item.costo_unitario,
    descuento_pct: item.descuento_pct,
    descuento_monto: item.descuento_monto,
    importe: plan.importe,
    costo_pieza: plan.costo_pieza,
    stock_antes: plan.stock_antes,
    costo_antes: plan.costo_antes,
    costo_despues: plan.costo_despues,
    precio_antes: plan.precio_antes,
    precio_despues: plan.precio_despues,
    mayoreo_antes: plan.mayoreo_antes,
    mayoreo_despues: plan.mayoreo_despues,
    revendedor_antes: plan.revendedor_antes,
    revendedor_despues: plan.revendedor_despues,
  };
}

function escaparLike(texto) {
  return texto.replace(/[\\%_]/g, '\\$&');
}

// Buscar accesorios para agregar a la compra: por nombre, SKU o la clave que le da ESTE proveedor (la que
// coincide exacta sale primero). Trae costo promedio, precios y stock para mostrarlos al capturar.
router.get('/productos', async (req, res) => {
  try {
    const q = String(req.query.q ?? '').trim();
    const proveedorId = UUID_RE.test(req.query.proveedor_id ?? '') ? req.query.proveedor_id : null;
    const sucursalId = UUID_RE.test(req.query.sucursal_id ?? '') ? req.query.sucursal_id : null;
    const patron = `%${escaparLike(q)}%`;
    const { rows } = await pool.query(
      `SELECT p.id, p.nombre, p.sku, p.tipo, p.color, p.almacenamiento, p.costo,
              p.precio_venta, p.precio_mayoreo, p.precio_revendedor,
              COALESCE((SELECT sum(stock_cantidad) FROM inventario WHERE producto_id = p.id), 0)::int AS stock_total,
              COALESCE((SELECT stock_cantidad FROM inventario WHERE producto_id = p.id AND sucursal_id = $3::uuid), 0)::int AS stock_sucursal,
              k.clave AS clave_proveedor,
              (k.clave IS NOT NULL AND $1 <> '' AND lower(k.clave) = lower($1)) AS coincide_clave
       FROM productos p
       LEFT JOIN producto_proveedor_claves k ON k.producto_id = p.id AND k.proveedor_id = $2::uuid
       WHERE p.activo AND p.tipo = 'accesorio'
         AND ($1 = '' OR p.nombre ILIKE $4 OR p.sku ILIKE $4 OR k.clave ILIKE $4)
       ORDER BY coincide_clave DESC, p.nombre
       LIMIT 25`,
      [q, proveedorId, sucursalId, patron]
    );
    res.json(rows);
  } catch (err) {
    responderError(res, err);
  }
});

// Vista previa: que pasaria con el costo y los precios de cada renglon, sin guardar nada.
router.post('/previsualizar', async (req, res) => {
  try {
    const config = await obtenerConfiguracionTicket();
    const renglones = validarRenglones(req.body?.items);
    const opciones = normalizarOpciones(req.body ?? {}, config);
    const productos = await cargarProductos(pool, renglones.map((r) => r.producto_id));
    const plan = armarPlan(renglones, productos, opciones);
    res.json({ ...totalesCompra(plan.map((p) => p.plan.importe), opciones.iva_tasa), opciones, renglones: plan.map(resumenRenglon) });
  } catch (err) {
    responderError(res, err);
  }
});

// Lee una factura (XML del SAT, PDF o foto) y propone la compra: proveedor, folio, fecha, renglones con el producto que
// parece corresponder y el IVA. No guarda nada: la persona revisa y confirma en la pantalla. El XML se lee aqui mismo; el
// PDF y la foto los lee la IA de n8n (N8N_WEBHOOK_LEER_FACTURA). El tipo se detecta por el contenido del archivo.
router.post('/leer-factura', async (req, res) => {
  try {
    const { nombre, contenido_base64: contenido } = req.body ?? {};
    const buffer = decodificarArchivo(contenido);
    const archivo = detectarArchivo(buffer);
    if (!archivo) throw falla(400, 'El archivo debe ser el XML de la factura, un PDF o una foto (JPG, PNG o WEBP).');
    let factura;
    if (archivo.tipo === 'xml') {
      if (buffer.length > MAX_BYTES_XML) throw falla(413, 'El XML pesa más de 2 MB: no parece una factura.');
      factura = leerCfdi(buffer.toString('utf8'));
    } else {
      factura = await leerFacturaConIA({ archivo, buffer, nombre, usuarioId: req.usuario.sub });
    }
    res.json({ ...(await construirPropuesta(pool, factura)), archivo: archivo.tipo });
  } catch (err) {
    responderError(res, err);
  }
});

// Da de alta de una vez los accesorios de una factura que todavia no existen en el inventario. Solo nombre y precio de venta
// (el costo y las existencias los pone la compra al registrarse). Todo o nada: si uno falla no se crea ninguno, para no dejar
// altas a medias. No deja crear un producto con el mismo nombre que uno activo (casi siempre es el mismo producto).
const norm = (t) => sinAcentos(t).toLowerCase().replace(/\s+/g, ' ').trim();
router.post('/productos-nuevos', async (req, res) => {
  const client = await pool.connect();
  try {
    const lista = req.body?.productos;
    if (!Array.isArray(lista) || lista.length === 0) throw falla(400, 'No hay productos por crear.');
    if (lista.length > MAX_RENGLONES) throw falla(400, `Se pueden crear hasta ${MAX_RENGLONES} productos a la vez.`);
    const vistos = new Set();
    const productos = lista.map((p, i) => {
      const n = i + 1;
      const nombre = typeof p?.nombre === 'string' ? p.nombre.trim().replace(/\s+/g, ' ') : '';
      if (!nombre) throw falla(400, `Producto ${n}: el nombre es requerido.`);
      if (nombre.length > 200) throw falla(400, `Producto ${n}: el nombre es demasiado largo (máximo 200 caracteres).`);
      if (!(esNumero(p.precio_venta) && p.precio_venta > 0 && p.precio_venta <= 100000000)) throw falla(400, `"${nombre}": el precio de venta debe ser mayor a 0.`);
      if (vistos.has(norm(nombre))) throw falla(400, `"${nombre}" está repetido: crea un solo producto y suma las cantidades.`);
      vistos.add(norm(nombre));
      return { nombre, precio_venta: Math.round((p.precio_venta + Number.EPSILON) * 100) / 100 };
    });

    await client.query('BEGIN');
    const existentes = await client.query(`SELECT nombre FROM productos WHERE activo AND tipo = 'accesorio'`);
    const yaExiste = new Set(existentes.rows.map((r) => norm(r.nombre)));
    for (const p of productos) {
      if (yaExiste.has(norm(p.nombre))) throw falla(409, `"${p.nombre}" ya existe en tu inventario: elígelo en lugar de crearlo.`);
    }
    const creados = [];
    for (const p of productos) {
      const { rows } = await client.query(
        `INSERT INTO productos (nombre, tipo, usa_imei, precio_venta, costo, activo) VALUES ($1, 'accesorio', false, $2, 0, true) RETURNING id, sku, nombre, precio_venta`,
        [p.nombre, p.precio_venta]
      );
      creados.push({ id: rows[0].id, sku: rows[0].sku, nombre: rows[0].nombre, precio_venta: Number(rows[0].precio_venta), costo: 0, stock_total: 0 });
    }
    await client.query('COMMIT');
    res.status(201).json(creados);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    responderError(res, err);
  } finally {
    client.release();
  }
});

// fecha_factura sale como texto 'YYYY-MM-DD': node-pg convierte un DATE a medianoche del servidor (UTC) y en Mexico eso se leeria
// como el dia anterior.
router.get('/', async (req, res) => {
  try {
    const { proveedor_id, estado, desde, hasta, q } = req.query;
    const sucursalId = sucursalDeTrabajo(req, req.query.sucursal_id || null);
    const limite = Math.min(Math.max(parseInt(req.query.limite, 10) || 200, 1), 500);
    const patron = q ? `%${escaparLike(String(q).trim())}%` : null;
    const { rows } = await pool.query(
      `SELECT c.id, c.folio, c.folio_proveedor, to_char(c.fecha_factura, 'YYYY-MM-DD') AS fecha_factura, c.created_at, c.estado, c.forma_pago, c.pagado_de_caja,
              c.subtotal, c.total, c.sucursal_id, s.nombre AS sucursal_nombre,
              c.proveedor_id, pv.nombre AS proveedor_nombre, u.nombre AS usuario_nombre,
              (SELECT count(*)::int FROM compra_items ci WHERE ci.compra_id = c.id) AS renglones
       FROM compras c
       JOIN proveedores pv ON pv.id = c.proveedor_id
       JOIN sucursales s ON s.id = c.sucursal_id
       LEFT JOIN usuarios u ON u.id = c.usuario_id
       WHERE ($1::uuid IS NULL OR c.sucursal_id = $1::uuid)
         AND ($2::uuid IS NULL OR c.proveedor_id = $2::uuid)
         AND ($3::text IS NULL OR c.estado = $3)
         AND ($4::timestamptz IS NULL OR c.created_at >= $4::timestamptz)
         AND ($5::timestamptz IS NULL OR c.created_at < $5::timestamptz)
         AND ($6::text IS NULL OR c.folio ILIKE $6 OR c.folio_proveedor ILIKE $6 OR pv.nombre ILIKE $6)
       ORDER BY c.created_at DESC
       LIMIT $7`,
      [
        sucursalId,
        UUID_RE.test(proveedor_id ?? '') ? proveedor_id : null,
        ['registrada', 'cancelada'].includes(estado) ? estado : null,
        desde && esFechaValida(desde) ? inicioDiaUTC(desde) : null,
        hasta && esFechaValida(hasta) ? finDiaUTCExclusivo(hasta) : null,
        patron,
        limite,
      ]
    );
    res.json(rows);
  } catch (err) {
    responderError(res, err);
  }
});

router.get('/:id', async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) throw falla(404, 'Compra no encontrada.');
    const compra = await pool.query(
      `SELECT c.*, to_char(c.fecha_factura, 'YYYY-MM-DD') AS fecha_factura, pv.nombre AS proveedor_nombre, s.nombre AS sucursal_nombre, u.nombre AS usuario_nombre, uc.nombre AS cancelada_por_nombre
       FROM compras c
       JOIN proveedores pv ON pv.id = c.proveedor_id
       JOIN sucursales s ON s.id = c.sucursal_id
       LEFT JOIN usuarios u ON u.id = c.usuario_id
       LEFT JOIN usuarios uc ON uc.id = c.cancelada_por
       WHERE c.id = $1`,
      [req.params.id]
    );
    if (!compra.rows[0]) throw falla(404, 'Compra no encontrada.');
    sucursalDeTrabajo(req, compra.rows[0].sucursal_id);
    const items = await pool.query(
      `SELECT ci.*, p.nombre, p.sku, p.tipo
       FROM compra_items ci JOIN productos p ON p.id = ci.producto_id
       WHERE ci.compra_id = $1 ORDER BY p.nombre`,
      [req.params.id]
    );
    res.json({ ...compra.rows[0], items: items.rows });
  } catch (err) {
    responderError(res, err);
  }
});

router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const body = req.body ?? {};
    if (!UUID_RE.test(body.proveedor_id ?? '')) throw falla(400, 'Elige el proveedor.');
    const sucursalId = sucursalDeTrabajo(req, body.sucursal_id || null);
    if (!sucursalId || !UUID_RE.test(sucursalId)) throw falla(400, 'Elige la sucursal que recibe la compra.');
    if (!FORMAS_PAGO.includes(body.forma_pago)) throw falla(400, 'Elige la forma de pago.');
    const folioProveedor = typeof body.folio_proveedor === 'string' ? body.folio_proveedor.trim().slice(0, 60) : '';
    if (body.fecha_factura !== undefined && body.fecha_factura !== null && body.fecha_factura !== '') {
      if (!esFechaValida(body.fecha_factura)) throw falla(400, 'La fecha de la factura no es válida.');
      if (new Date(`${body.fecha_factura}T00:00:00Z`).getTime() > Date.now() + 36 * 3600 * 1000) throw falla(400, 'La fecha de la factura no puede ser futura.');
    }
    const comentario = typeof body.comentario === 'string' ? body.comentario.trim().slice(0, 500) : '';
    // Solo cuando la compra viene de una factura leida: el UUID del timbre (evita registrarla dos veces) y el RFC del
    // proveedor (se guarda si todavia no lo tenia, para reconocerlo la proxima vez).
    const uuidFactura = typeof body.uuid_factura === 'string' && body.uuid_factura.trim() ? body.uuid_factura.trim().toUpperCase() : null;
    if (uuidFactura && !/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(uuidFactura)) throw falla(400, 'El UUID de la factura no es válido.');
    const proveedorRfc = typeof body.proveedor_rfc === 'string' && body.proveedor_rfc.trim() ? body.proveedor_rfc.trim().toUpperCase() : null;
    if (proveedorRfc && !esRfc(proveedorRfc)) throw falla(400, 'El RFC del proveedor no es válido.');
    const renglones = validarRenglones(body.items);
    const pagadoDeCaja = body.forma_pago === 'efectivo' && body.pagado_de_caja !== false;

    await client.query('BEGIN');

    const config = await obtenerConfiguracionTicket(client);
    const opciones = normalizarOpciones(body, config);

    const proveedor = await client.query(`SELECT id, nombre, activo FROM proveedores WHERE id = $1`, [body.proveedor_id]);
    if (!proveedor.rows[0]) throw falla(400, 'El proveedor no existe.');
    if (!proveedor.rows[0].activo) throw falla(400, 'El proveedor está dado de baja.');
    const sucursal = await client.query(`SELECT id FROM sucursales WHERE id = $1`, [sucursalId]);
    if (!sucursal.rows[0]) throw falla(400, 'La sucursal no existe.');

    const productos = await cargarProductos(client, renglones.map((r) => r.producto_id), { bloquear: true });
    const plan = armarPlan(renglones, productos, opciones);

    const totales = totalesCompra(plan.map((p) => p.plan.importe), opciones.iva_tasa);

    if (uuidFactura) {
      const repetida = await client.query(`SELECT folio FROM compras WHERE lower(uuid_factura) = lower($1) AND estado = 'registrada' LIMIT 1`, [uuidFactura]);
      if (repetida.rows[0]) throw falla(409, `Esa factura ya está registrada en la compra ${repetida.rows[0].folio}.`);
    }

    const compraRow = await client.query(
      `INSERT INTO compras (proveedor_id, sucursal_id, folio_proveedor, fecha_factura, iva_tasa, forma_pago, pagado_de_caja,
                            subtotal, total, precios_modo, redondeo_multiplo, redondeo_direccion, comentario, usuario_id, uuid_factura)
       VALUES ($1, $2, $3, COALESCE($4::date, current_date), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id, folio, created_at`,
      [
        body.proveedor_id, sucursalId, folioProveedor || null, body.fecha_factura || null, opciones.iva_tasa, body.forma_pago, pagadoDeCaja,
        totales.subtotal, totales.total, opciones.precios_modo, opciones.redondeo_multiplo, opciones.redondeo_direccion, comentario || null, req.usuario.sub,
        uuidFactura,
      ]
    );
    const compra = compraRow.rows[0];
    if (proveedorRfc) await client.query(`UPDATE proveedores SET rfc = $2 WHERE id = $1 AND rfc IS NULL`, [body.proveedor_id, proveedorRfc]);
    const motivoKardex = `Compra ${compra.folio} · ${proveedor.rows[0].nombre}${folioProveedor ? ` · factura ${folioProveedor}` : ''}`;

    for (const { item, producto, plan: p } of plan) {
      await client.query(
        `INSERT INTO compra_items (compra_id, producto_id, cantidad, piezas_por_unidad, piezas, costo_unitario, descuento_pct, descuento_monto, importe,
                                   clave_proveedor, costo_pieza, stock_antes, costo_antes, costo_despues,
                                   precio_antes, precio_despues, mayoreo_antes, mayoreo_despues, revendedor_antes, revendedor_despues)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
        [
          compra.id, producto.id, item.cantidad, p.piezas_por_unidad, p.piezas, item.costo_unitario, item.descuento_pct, item.descuento_monto, p.importe,
          item.clave_proveedor, p.costo_pieza, p.stock_antes, p.costo_antes, p.costo_despues,
          p.precio_antes, p.precio_despues, p.mayoreo_antes, p.mayoreo_despues, p.revendedor_antes, p.revendedor_despues,
        ]
      );

      await client.query(
        `INSERT INTO inventario (producto_id, sucursal_id, stock_cantidad) VALUES ($1, $2, $3)
         ON CONFLICT (producto_id, sucursal_id) DO UPDATE SET stock_cantidad = inventario.stock_cantidad + $3, updated_at = now()`,
        [producto.id, sucursalId, p.piezas]
      );
      await client.query(
        `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
         VALUES ($1, $2, 'entrada', $3, $4, 'compra', $5, $6)`,
        [producto.id, sucursalId, p.piezas, motivoKardex, compra.id, req.usuario.sub]
      );

      // Costo promedio, precios (solo cambian en modo margen) y ultimo proveedor del producto.
      await client.query(
        `UPDATE productos SET costo = $2, precio_venta = COALESCE($3, precio_venta), precio_mayoreo = COALESCE($4, precio_mayoreo),
                precio_revendedor = COALESCE($5, precio_revendedor), proveedor_id = $6
         WHERE id = $1`,
        [producto.id, p.costo_despues, p.precio_despues, p.mayoreo_despues, p.revendedor_despues, body.proveedor_id]
      );

      if (item.clave_proveedor) {
        await client.query(
          `INSERT INTO producto_proveedor_claves (proveedor_id, producto_id, clave) VALUES ($1, $2, $3)
           ON CONFLICT (proveedor_id, producto_id) DO UPDATE SET clave = EXCLUDED.clave, updated_at = now()`,
          [body.proveedor_id, producto.id, item.clave_proveedor]
        );
      }
    }

    // Efectivo de la caja: salida tipo 'compra' (resta del efectivo del corte; no es gasto en Finanzas).
    let gastoId = null;
    if (pagadoDeCaja && totales.total > 0) {
      const gasto = await client.query(
        `INSERT INTO gastos (sucursal_id, usuario_id, tipo, categoria, monto, descripcion, fecha)
         VALUES ($1, $2, 'compra', 'Compra de inventario', $3, $4, current_date) RETURNING id`,
        [sucursalId, req.usuario.sub, totales.total, motivoKardex]
      );
      gastoId = gasto.rows[0].id;
      await client.query(`UPDATE compras SET gasto_id = $2 WHERE id = $1`, [compra.id, gastoId]);
    }

    await client.query('COMMIT');
    res.status(201).json({
      id: compra.id,
      folio: compra.folio,
      ...totales,
      pagado_de_caja: pagadoDeCaja,
      gasto_id: gastoId,
      opciones,
      renglones: plan.map(resumenRenglon),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      const texto = `${err.constraint ?? ''} ${err.message ?? ''}`;
      if (texto.includes('idx_compras_proveedor_folio')) return responderError(res, falla(409, 'Ya hay una compra registrada de este proveedor con ese folio.'));
      if (texto.includes('idx_compras_uuid_factura')) return responderError(res, falla(409, 'Esa factura ya está registrada en otra compra.'));
      if (texto.includes('idx_producto_proveedor_claves_clave')) return responderError(res, falla(409, 'Esa clave ya está ligada a otro producto de este proveedor.'));
    }
    responderError(res, err);
  } finally {
    client.release();
  }
});

// Cancelar una compra registrada. Solo si se puede deshacer exacto: sin compras posteriores de esos productos,
// con stock suficiente para retirar lo que entro y, si salio efectivo de la caja,
// sin que se haya hecho el corte de ese turno. Queda marcada 'cancelada' (no se borra).
router.post('/:id/cancelar', async (req, res) => {
  const client = await pool.connect();
  try {
    if (!UUID_RE.test(req.params.id)) throw falla(404, 'Compra no encontrada.');
    const motivo = typeof req.body?.motivo === 'string' ? req.body.motivo.trim().slice(0, 300) : '';

    await client.query('BEGIN');
    const compraRow = await client.query(`SELECT * FROM compras WHERE id = $1 FOR UPDATE`, [req.params.id]);
    const compra = compraRow.rows[0];
    if (!compra) throw falla(404, 'Compra no encontrada.');
    sucursalDeTrabajo(req, compra.sucursal_id);
    if (compra.estado !== 'registrada') throw falla(409, 'Esta compra ya estaba cancelada.');

    const items = (await client.query(
      `SELECT ci.*, p.nombre, p.costo AS costo_actual FROM compra_items ci JOIN productos p ON p.id = ci.producto_id WHERE ci.compra_id = $1 ORDER BY p.id`,
      [compra.id]
    )).rows;
    await client.query(`SELECT id FROM productos WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [items.map((i) => i.producto_id)]);

    const problemas = [];
    for (const it of items) {
      const posterior = await client.query(
        `SELECT c.folio FROM compra_items ci JOIN compras c ON c.id = ci.compra_id
         WHERE ci.producto_id = $1 AND c.estado = 'registrada' AND c.id <> $2
           AND (c.created_at > $3 OR (c.created_at = $3 AND c.id > $2))
         ORDER BY c.created_at LIMIT 1`,
        [it.producto_id, compra.id, compra.created_at]
      );
      if (posterior.rows[0]) problemas.push(`"${it.nombre}" tiene una compra posterior (${posterior.rows[0].folio})`);

      const stock = await client.query(
        `SELECT stock_cantidad, stock_apartado FROM inventario WHERE producto_id = $1 AND sucursal_id = $2 FOR UPDATE`,
        [it.producto_id, compra.sucursal_id]
      );
      const disponible = stock.rows[0] ? stock.rows[0].stock_cantidad - stock.rows[0].stock_apartado : 0;
      if (disponible < it.piezas) problemas.push(`de "${it.nombre}" solo quedan ${Math.max(disponible, 0)} piezas libres y la compra metió ${it.piezas}`);
    }

    if (compra.gasto_id) {
      const gasto = (await client.query(`SELECT created_at, usuario_id FROM gastos WHERE id = $1`, [compra.gasto_id])).rows[0];
      if (gasto) {
        const modo = (await client.query(`SELECT modo_caja FROM sucursales WHERE id = $1`, [compra.sucursal_id])).rows[0]?.modo_caja ?? 'compartida';
        const corte = await client.query(
          `SELECT 1 FROM cortes_caja WHERE sucursal_id = $1 AND turno_fin >= $2 AND ($3::text <> 'individual' OR usuario_id = $4) LIMIT 1`,
          [compra.sucursal_id, gasto.created_at, modo, gasto.usuario_id]
        );
        if (corte.rows[0]) problemas.push('ya se hizo el corte de caja de ese turno con este pago en efectivo');
      }
    }

    if (problemas.length > 0) {
      throw falla(409, 'No se puede cancelar esta compra: ' + problemas.join('; ') + '. Si hace falta corregir algo, usa un ajuste de inventario.', { detalle: problemas });
    }

    const costosNoRevertidos = [];
    for (const it of items) {
      await client.query(`UPDATE inventario SET stock_cantidad = stock_cantidad - $3, updated_at = now() WHERE producto_id = $1 AND sucursal_id = $2`, [it.producto_id, compra.sucursal_id, it.piezas]);
      await client.query(
        `INSERT INTO movimientos_inventario (producto_id, sucursal_id, tipo, cantidad, motivo, referencia_tipo, referencia_id, usuario_id)
         VALUES ($1, $2, 'salida', $3, $4, 'compra_cancelacion', $5, $6)`,
        [it.producto_id, compra.sucursal_id, it.piezas, `Cancelación de compra ${compra.folio}`, compra.id, req.usuario.sub]
      );
      // El costo vuelve a como estaba solo si nadie lo cambio a mano despues de la compra; los precios no se revierten.
      if (Math.abs(Number(it.costo_actual) - Number(it.costo_despues)) < 0.005) {
        await client.query(`UPDATE productos SET costo = $2 WHERE id = $1`, [it.producto_id, it.costo_antes]);
      } else {
        costosNoRevertidos.push(it.nombre);
      }
    }
    if (compra.gasto_id) await client.query(`DELETE FROM gastos WHERE id = $1`, [compra.gasto_id]);

    await client.query(
      `UPDATE compras SET estado = 'cancelada', cancelada_at = now(), cancelada_por = $2, motivo_cancelacion = $3 WHERE id = $1`,
      [compra.id, req.usuario.sub, motivo || null]
    );
    await client.query('COMMIT');
    res.json({ id: compra.id, folio: compra.folio, estado: 'cancelada', costos_no_revertidos: costosNoRevertidos });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    responderError(res, err);
  } finally {
    client.release();
  }
});

module.exports = router;
