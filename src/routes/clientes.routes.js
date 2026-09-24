const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, esAdminODueno } = require('../middleware/auth');
const { marcarCreditosVencidos } = require('../utils/creditos');
const { liberarApartadosVencidos } = require('../utils/apartados');

const router = express.Router();

router.use(requireAuth, requireRole('admin', 'vendedor', 'tecnico'));

const TIPOS_PRECIO_VALIDOS = ['publico', 'revendedor', 'mayoreo'];
// Campos de politica de credito -- solo Admin/Dueño puede autorizarlos o
// cambiarlos (mismo criterio que "vender a credito" en ventas.routes.js).
const CAMPOS_CREDITO = ['permite_credito', 'limite_credito', 'plazo_dias_credito'];

router.get('/', async (req, res) => {
  const { q } = req.query;
  await marcarCreditosVencidos(pool);
  const { rows } = await pool.query(
    `SELECT c.id, c.nombre, c.telefono, c.telefono_adicional, c.email, c.direccion, c.notas, c.tipo_precio, c.origen, c.created_at,
            c.permite_credito, c.limite_credito, c.plazo_dias_credito,
            COALESCE(v.numero_compras, 0) AS numero_compras,
            COALESCE(r.numero_reparaciones, 0) AS numero_reparaciones,
            GREATEST(v.ultima_compra, r.ultima_reparacion) AS ultima_visita,
            COALESCE(cr.saldo_credito_pendiente, 0) AS saldo_credito_pendiente
     FROM clientes c
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS numero_compras, max(created_at) AS ultima_compra
       FROM ventas WHERE cliente_id = c.id AND estado = 'completada'
     ) v ON true
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS numero_reparaciones, max(created_at) AS ultima_reparacion
       FROM reparaciones WHERE cliente_id = c.id
     ) r ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(saldo_pendiente), 0) AS saldo_credito_pendiente
       FROM creditos WHERE cliente_id = c.id AND estado IN ('activo', 'vencido')
     ) cr ON true
     WHERE ($1::text IS NULL OR c.nombre ILIKE '%' || $1 || '%' OR c.telefono ILIKE '%' || $1 || '%' OR c.telefono_adicional ILIKE '%' || $1 || '%')
     ORDER BY c.nombre
     LIMIT 300`,
    [q || null]
  );
  res.json(rows);
});

// Trae los abonos de una lista de creditos/apartados en una sola consulta
// (evita N+1) y los agrupa en memoria por el id del padre.
async function abonosAgrupados(tabla, columnaPadre, idsPadre) {
  if (idsPadre.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT a.${columnaPadre} AS padre_id, a.id, a.monto, a.metodo, a.created_at, u.nombre AS usuario_nombre
     FROM ${tabla} a LEFT JOIN usuarios u ON u.id = a.usuario_id
     WHERE a.${columnaPadre} = ANY($1::uuid[])
     ORDER BY a.created_at DESC`,
    [idsPadre]
  );
  const porPadre = new Map();
  for (const row of rows) {
    if (!porPadre.has(row.padre_id)) porPadre.set(row.padre_id, []);
    porPadre.get(row.padre_id).push(row);
  }
  return porPadre;
}

router.get('/:id', async (req, res) => {
  await marcarCreditosVencidos(pool);
  await liberarApartadosVencidos(pool);
  const { rows } = await pool.query(
    `SELECT id, nombre, telefono, telefono_adicional, email, direccion, notas, tipo_precio, origen,
            permite_credito, limite_credito, plazo_dias_credito, created_at
     FROM clientes WHERE id = $1`,
    [req.params.id]
  );
  const cliente = rows[0];
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado.' });

  const historial = await pool.query(
    `SELECT count(*)::int AS numero_ventas, COALESCE(sum(total), 0) AS total_comprado, max(created_at) AS ultima_compra
     FROM ventas WHERE cliente_id = $1 AND estado = 'completada'`,
    [req.params.id]
  );

  const creditos = await pool.query(
    `SELECT c.id, c.monto_total, c.saldo_pendiente, c.limite_aprobado, c.condiciones, c.estado, c.fecha_vencimiento, c.created_at,
            u.nombre AS autorizado_por_nombre
     FROM creditos c LEFT JOIN usuarios u ON u.id = c.autorizado_por
     WHERE c.cliente_id = $1
     ORDER BY c.created_at DESC`,
    [req.params.id]
  );
  const abonosPorCredito = await abonosAgrupados('abonos', 'credito_id', creditos.rows.map((c) => c.id));

  const apartados = await pool.query(
    `SELECT a.id, a.folio, a.producto_id, p.nombre AS producto_nombre, a.cantidad, a.precio_total, a.monto_abonado, a.estado, a.origen, a.vence_at, a.created_at
     FROM apartados a JOIN productos p ON p.id = a.producto_id
     WHERE a.cliente_id = $1
     ORDER BY a.created_at DESC`,
    [req.params.id]
  );
  const abonosPorApartado = await abonosAgrupados('apartado_abonos', 'apartado_id', apartados.rows.map((a) => a.id));

  res.json({
    ...cliente,
    ...historial.rows[0],
    creditos: creditos.rows.map((c) => ({ ...c, abonos: abonosPorCredito.get(c.id) ?? [] })),
    apartados: apartados.rows.map((a) => ({ ...a, abonos: abonosPorApartado.get(a.id) ?? [] })),
  });
});

function validarCampoCredito(campo, valor, errores) {
  if (valor === undefined || valor === null) return;
  if (campo === 'permite_credito' && typeof valor !== 'boolean') errores.push('permite_credito debe ser verdadero/falso.');
  if (campo === 'limite_credito' && !(Number(valor) >= 0)) errores.push('limite_credito debe ser un número mayor o igual a 0.');
  if (campo === 'plazo_dias_credito' && !(Number.isInteger(Number(valor)) && Number(valor) >= 1)) {
    errores.push('plazo_dias_credito debe ser un entero mayor o igual a 1.');
  }
}

router.post('/', async (req, res) => {
  const { nombre, telefono, telefono_adicional, email, direccion, notas, tipo_precio, permite_credito, limite_credito, plazo_dias_credito } = req.body ?? {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido.' });
  if (tipo_precio !== undefined && !TIPOS_PRECIO_VALIDOS.includes(tipo_precio)) {
    return res.status(400).json({ error: 'tipo_precio inválido.' });
  }
  const erroresCredito = [];
  CAMPOS_CREDITO.forEach((c) => validarCampoCredito(c, req.body?.[c], erroresCredito));
  if (erroresCredito.length > 0) return res.status(400).json({ error: erroresCredito[0] });
  // La autorizacion de credito es responsabilidad del Admin/Dueño, mismo
  // criterio que "vender a credito" en ventas.routes.js.
  if ((permite_credito !== undefined || limite_credito !== undefined || plazo_dias_credito !== undefined) && !esAdminODueno(req.usuario.rol)) {
    return res.status(403).json({ error: 'Solo un administrador puede configurar la política de crédito de un cliente.' });
  }

  const { rows } = await pool.query(
    `INSERT INTO clientes (nombre, telefono, telefono_adicional, email, direccion, notas, tipo_precio, permite_credito, limite_credito, plazo_dias_credito)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, nombre, telefono, telefono_adicional, email, direccion, notas, tipo_precio, permite_credito, limite_credito, plazo_dias_credito, created_at`,
    [
      nombre.trim(),
      telefono || null,
      telefono_adicional || null,
      email || null,
      direccion || null,
      notas || null,
      tipo_precio || 'publico',
      permite_credito ?? false,
      limite_credito ?? null,
      plazo_dias_credito ?? null,
    ]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', async (req, res) => {
  if (req.body?.tipo_precio !== undefined && !TIPOS_PRECIO_VALIDOS.includes(req.body.tipo_precio)) {
    return res.status(400).json({ error: 'tipo_precio inválido.' });
  }
  const erroresCredito = [];
  CAMPOS_CREDITO.forEach((c) => validarCampoCredito(c, req.body?.[c], erroresCredito));
  if (erroresCredito.length > 0) return res.status(400).json({ error: erroresCredito[0] });
  if (CAMPOS_CREDITO.some((c) => req.body?.[c] !== undefined) && !esAdminODueno(req.usuario.rol)) {
    return res.status(403).json({ error: 'Solo un administrador puede configurar la política de crédito de un cliente.' });
  }

  const fields = {
    nombre: req.body?.nombre,
    telefono: req.body?.telefono,
    telefono_adicional: req.body?.telefono_adicional,
    email: req.body?.email,
    direccion: req.body?.direccion,
    notas: req.body?.notas,
    tipo_precio: req.body?.tipo_precio,
    permite_credito: req.body?.permite_credito,
    limite_credito: req.body?.limite_credito,
    plazo_dias_credito: req.body?.plazo_dias_credito,
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
    `UPDATE clientes SET ${sets.join(', ')} WHERE id = $${i}
     RETURNING id, nombre, telefono, telefono_adicional, email, direccion, notas, tipo_precio, permite_credito, limite_credito, plazo_dias_credito, created_at`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Cliente no encontrado.' });
  res.json(rows[0]);
});

module.exports = router;
