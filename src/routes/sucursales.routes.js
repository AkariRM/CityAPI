const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// El listado es de lectura y lo necesita cualquier rol autenticado (elegir
// sucursal al importar equipos, fijar la sucursal del dispositivo en
// Configuracion, etc.) — solo dar de alta/editar sucursales sigue siendo
// exclusivo de quien administra el catalogo de sucursales.
router.get('/', async (req, res) => {
  const { activo } = req.query;
  // Sin parametro: solo activas (comportamiento historico, lo que ya usan
  // Usuarios/Configuracion/el filtro de sucursal). "todas" es el unico valor
  // que quita el filtro — lo usa la pantalla de administracion de sucursales
  // para poder ver y reactivar las dadas de baja.
  const filtro = activo === undefined ? true : activo === 'todas' ? null : activo === 'true';
  const { rows } = await pool.query(
    `SELECT id, nombre, direccion, telefono, fondo_caja_default, activo FROM sucursales
     WHERE ($1::boolean IS NULL OR activo = $1::boolean)
     ORDER BY nombre`,
    [filtro]
  );
  res.json(rows);
});

router.post('/', requireRole('admin'), async (req, res) => {
  const { nombre, direccion, telefono, fondo_caja_default } = req.body ?? {};
  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido.' });

  const { rows } = await pool.query(
    `INSERT INTO sucursales (nombre, direccion, telefono, fondo_caja_default) VALUES ($1, $2, $3, $4)
     RETURNING id, nombre, direccion, telefono, fondo_caja_default, activo`,
    [nombre.trim(), direccion || null, telefono || null, Number(fondo_caja_default) || 0]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', requireRole('admin'), async (req, res) => {
  const fields = {
    nombre: req.body?.nombre,
    direccion: req.body?.direccion,
    telefono: req.body?.telefono,
    fondo_caja_default: req.body?.fondo_caja_default,
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
  if (sets.length === 0) return res.status(400).json({ error: 'Nada que actualizar.' });

  values.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE sucursales SET ${sets.join(', ')} WHERE id = $${i}
     RETURNING id, nombre, direccion, telefono, fondo_caja_default, activo`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Sucursal no encontrada.' });
  res.json(rows[0]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Eliminar una sucursal (solo el Administrador). Es definitivo.
//
// Todo va en UNA transaccion (o se hace todo o no se toca nada):
//  1. El historial de la sucursal (ventas, reparaciones, caja, gastos, apartados, cambios, compras, movimientos,
//     equipos con IMEI, clientes, fila de espera...) pasa a la sucursal destino (mover_a). Las existencias se
//     SUMAN a las del destino. Sin historial no hace falta destino.
//  2. Los usuarios ligados a la sucursal se eliminan. Si un usuario tiene movimientos a su nombre (ventas, cortes,
//     abonos...) no se puede borrar sin falsificar ese historial: se deja INACTIVO y sin sucursal, y se avisa.
//     Nunca se elimina al Administrador ni al usuario que esta borrando.
//  3. Se borra la sucursal y queda un renglon en auditoria.
// Las tablas que apuntan a sucursales se descubren en el catalogo de Postgres, asi una tabla nueva no se queda sin
// mover (si aun asi algo la retuviera, la transaccion se deshace y se avisa cual).
// ─────────────────────────────────────────────────────────────────────────────

// Nombre legible de cada tabla para los avisos.
const ETIQUETA_TABLA = {
  ventas: 'ventas',
  reparaciones: 'reparaciones',
  cortes_caja: 'cortes de caja',
  gastos: 'gastos',
  apartados: 'apartados',
  cambios_equipo: 'cambios de equipo',
  ordenes_compra: 'órdenes de compra',
  movimientos_inventario: 'movimientos de inventario',
  unidades_imei: 'equipos con IMEI',
  inventario: 'productos con existencias',
  clientes: 'clientes',
  fila_espera: 'fila de espera',
};
// Inventario unico del taller: ya no pertenece a ninguna sucursal, solo se limpia la referencia.
const SOLO_LIMPIAR = new Set(['refacciones', 'movimientos_refacciones']);

async function tablasLigadas(db) {
  const { rows } = await db.query(
    `SELECT c.conrelid::regclass::text AS tabla, a.attname AS columna
     FROM pg_constraint c
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND c.confrelid = 'sucursales'::regclass AND array_length(c.conkey, 1) = 1
     ORDER BY 1`
  );
  return rows;
}

// Que hay ligado a la sucursal: usuarios y, por tabla, cuantos registros (el historial que hay que mover).
async function impactoSucursal(db, id) {
  const usuarios = (await db.query(
    `SELECT id, nombre, rol FROM usuarios WHERE sucursal_id = $1 ORDER BY nombre`, [id]
  )).rows;
  const historial = [];
  for (const { tabla, columna } of await tablasLigadas(db)) {
    if (tabla === 'usuarios' || tabla === 'sesiones' || SOLO_LIMPIAR.has(tabla)) continue;
    const sql = tabla === 'inventario'
      ? `SELECT count(*)::int AS n FROM inventario WHERE sucursal_id = $1 AND (stock_cantidad > 0 OR stock_apartado > 0)`
      : `SELECT count(*)::int AS n FROM ${tabla} WHERE ${columna} = $1`;
    const n = (await db.query(sql, [id])).rows[0].n;
    if (n > 0) historial.push({ tabla, etiqueta: ETIQUETA_TABLA[tabla] ?? tabla, cantidad: n });
  }
  return { usuarios, historial, total_historial: historial.reduce((suma, h) => suma + h.cantidad, 0) };
}

// Lo que se va a mover / borrar, para mostrarlo antes de confirmar.
router.get('/:id/impacto', requireRole('dueño'), async (req, res) => {
  const sucursal = (await pool.query(`SELECT id, nombre FROM sucursales WHERE id = $1`, [req.params.id])).rows[0];
  if (!sucursal) return res.status(404).json({ error: 'Sucursal no encontrada.' });
  const otras = (await pool.query(`SELECT count(*)::int AS n FROM sucursales WHERE id <> $1 AND activo = true`, [req.params.id])).rows[0].n;
  res.json({ sucursal, otras_sucursales_activas: otras, ...(await impactoSucursal(pool, req.params.id)) });
});

router.delete('/:id', requireRole('dueño'), async (req, res) => {
  const { mover_a, confirmar } = req.body ?? {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sucursal = (await client.query(`SELECT id, nombre, direccion, telefono FROM sucursales WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!sucursal) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Sucursal no encontrada.' });
    }
    if (String(confirmar ?? '').trim() !== sucursal.nombre.trim()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Escribe el nombre exacto de la sucursal para confirmar.' });
    }
    const cuantas = (await client.query(`SELECT count(*)::int AS n FROM sucursales`)).rows[0].n;
    if (cuantas <= 1) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'No puedes eliminar la única sucursal.' });
    }

    const impacto = await impactoSucursal(client, sucursal.id);
    let destino = null;
    if (impacto.total_historial > 0) {
      if (!mover_a) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Esta sucursal tiene historial: elige a qué sucursal pasa para poder eliminarla.',
          requiere_destino: true,
          historial: impacto.historial,
        });
      }
    }
    if (mover_a) {
      if (mover_a === sucursal.id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'La sucursal destino tiene que ser otra.' });
      }
      destino = (await client.query(`SELECT id, nombre FROM sucursales WHERE id = $1 AND activo = true`, [mover_a])).rows[0];
      if (!destino) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'La sucursal destino no existe o está inactiva.' });
      }
    }

    // 1) Historial: pasa al destino (las existencias se suman).
    for (const { tabla, columna } of await tablasLigadas(client)) {
      if (tabla === 'usuarios') continue;
      if (tabla === 'sesiones') {
        await client.query(`DELETE FROM sesiones WHERE sucursal_id = $1`, [sucursal.id]);
      } else if (SOLO_LIMPIAR.has(tabla)) {
        await client.query(`UPDATE ${tabla} SET ${columna} = NULL WHERE ${columna} = $1`, [sucursal.id]);
      } else if (tabla === 'inventario') {
        if (destino) {
          await client.query(
            `INSERT INTO inventario (producto_id, sucursal_id, stock_cantidad, stock_apartado, stock_minimo)
             SELECT producto_id, $2, stock_cantidad, stock_apartado, stock_minimo FROM inventario WHERE sucursal_id = $1
             ON CONFLICT (producto_id, sucursal_id) DO UPDATE
               SET stock_cantidad = inventario.stock_cantidad + EXCLUDED.stock_cantidad,
                   stock_apartado = inventario.stock_apartado + EXCLUDED.stock_apartado,
                   updated_at = now()`,
            [sucursal.id, destino.id]
          );
        }
        await client.query(`DELETE FROM inventario WHERE sucursal_id = $1`, [sucursal.id]);
      } else if (destino) {
        await client.query(`UPDATE ${tabla} SET ${columna} = $2 WHERE ${columna} = $1`, [sucursal.id, destino.id]);
      }
    }

    // 2) Usuarios ligados: se eliminan; si tienen movimientos a su nombre, quedan inactivos y sin sucursal.
    const eliminados = [];
    const conservados = [];
    for (const u of impacto.usuarios) {
      if (u.rol === 'dueño' || u.id === req.usuario.sub) {
        await client.query(`UPDATE usuarios SET sucursal_id = NULL WHERE id = $1`, [u.id]);
        conservados.push({ id: u.id, nombre: u.nombre, motivo: 'Administrador (se conserva, solo se desliga de la sucursal)' });
        continue;
      }
      await client.query(`DELETE FROM sesiones WHERE usuario_id = $1`, [u.id]);
      await client.query(`DELETE FROM notificaciones WHERE usuario_id = $1`, [u.id]);
      await client.query('SAVEPOINT usuario');
      try {
        await client.query(`DELETE FROM usuarios WHERE id = $1`, [u.id]);
        await client.query('RELEASE SAVEPOINT usuario');
        eliminados.push({ id: u.id, nombre: u.nombre });
      } catch (err) {
        if (err.code !== '23503') throw err;
        await client.query('ROLLBACK TO SAVEPOINT usuario');
        await client.query(`UPDATE usuarios SET activo = false, sucursal_id = NULL WHERE id = $1`, [u.id]);
        conservados.push({ id: u.id, nombre: u.nombre, motivo: 'Tiene movimientos a su nombre: se dejó inactivo' });
      }
    }

    // 3) La sucursal y su rastro en auditoria.
    await client.query(`DELETE FROM sucursales WHERE id = $1`, [sucursal.id]);
    await client.query(
      `INSERT INTO auditoria (usuario_id, accion, entidad, entidad_id, datos_previos, datos_nuevos)
       VALUES ($1, 'eliminar', 'sucursal', $2, $3, $4)`,
      [
        req.usuario.sub,
        sucursal.id,
        JSON.stringify({ nombre: sucursal.nombre, direccion: sucursal.direccion, telefono: sucursal.telefono }),
        JSON.stringify({ movido_a: destino?.nombre ?? null, historial: impacto.historial, usuarios_eliminados: eliminados.length, usuarios_conservados: conservados.length }),
      ]
    );

    await client.query('COMMIT');
    res.json({
      eliminada: true,
      nombre: sucursal.nombre,
      movido_a: destino?.nombre ?? null,
      historial: impacto.historial,
      usuarios_eliminados: eliminados,
      usuarios_conservados: conservados,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23503') {
      // Algo mas todavia apunta a la sucursal: no se borro nada.
      const ligada = /table "([^"]+)"/.exec(err.detail ?? '')?.[1] ?? 'otra tabla';
      return res.status(409).json({ error: `No se pudo eliminar: aún hay datos ligados a la sucursal (${ligada}). No se borró nada.` });
    }
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  } finally {
    client.release();
  }
});

module.exports = router;
