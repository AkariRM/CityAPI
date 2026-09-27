const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { isValidPin, hashPin } = require('../utils/pin');
const { isValidPassword, MENSAJE_PASSWORD, hashPassword, hashInservible, normalizarCorreo, esCorreoValido } = require('../utils/password');

const router = express.Router();
const ROLES_VALIDOS = ['dueño', 'admin', 'vendedor', 'tecnico', 'community_manager', 'pto', 'supervisor_taller'];
// Personal del taller de reparacion (compartido por todas las sucursales): no lleva sucursal.
const ROLES_DEL_TALLER = ['tecnico', 'supervisor_taller'];
// Roles que solo existen en CityPhone y siempre necesitan sucursal — 'admin'
// (Supervisor) no entra aqui porque tambien puede ser de Áurea (via su propio
// empresa_id), y Áurea no tiene sucursales todavia (fase 1); en ese caso se
// resuelve abajo comparando contra la empresa real del usuario.
const ROLES_CITYPHONE_CON_SUCURSAL = ['vendedor', 'community_manager'];

router.use(requireAuth, requireRole('dueño', 'admin'));

router.get('/', async (req, res) => {
  // El Dueño ve ambas empresas (las administra); cualquier otro rol (admin/
  // Supervisor) solo ve las cuentas de su propia empresa — antes esto no se
  // filtraba y un Supervisor de CityPhone veia tambien las cuentas de Áurea.
  const filtroEmpresa = req.usuario.rol === 'dueño' ? null : req.usuario.empresa_id;
  const { rows } = await pool.query(
    `SELECT u.id, u.nombre, u.telefono, u.email, u.rol, u.sucursal_id, u.empresa_id,
            s.nombre AS sucursal_nombre, e.nombre AS empresa_nombre, u.activo, u.created_at
     FROM usuarios u
     LEFT JOIN sucursales s ON s.id = u.sucursal_id
     LEFT JOIN empresas e ON e.id = u.empresa_id
     WHERE ($1::uuid IS NULL OR u.empresa_id = $1::uuid)
     ORDER BY u.nombre`,
    [filtroEmpresa]
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { nombre, telefono, email, rol, sucursal_id, empresa_id, pin, password } = req.body ?? {};

  if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido.' });
  if (!ROLES_VALIDOS.includes(rol)) return res.status(400).json({ error: 'Rol inválido.' });

  // Credencial: la cuenta entra con CORREO Y CONTRASEÑA. (Una version anterior de la app manda solo un PIN de 4
  // digitos: se acepta mientras dure la transicion y queda como contraseña.)
  const correo = email ? normalizarCorreo(email) : null;
  if (correo && !esCorreoValido(correo)) return res.status(400).json({ error: 'El correo no es válido.' });
  let credencial;
  if (password !== undefined) {
    if (!correo) return res.status(400).json({ error: 'El correo es requerido.' });
    if (!isValidPassword(password)) return res.status(400).json({ error: MENSAJE_PASSWORD });
    credencial = { password_hash: hashPassword(password), pin_hash: hashInservible() };
  } else {
    if (!isValidPin(pin)) return res.status(400).json({ error: 'La contraseña es requerida.' });
    const h = hashPin(pin);
    credencial = { password_hash: h, pin_hash: h };
  }

  // Asignar acceso de Dueño o Admin (osea, a una empresa completa) es
  // decisión exclusiva del Dueño — un Admin normal no puede crear otro
  // Admin ni ascender a Dueño.
  if ((rol === 'dueño' || rol === 'admin') && req.usuario.rol !== 'dueño') {
    return res.status(403).json({ error: 'Solo el Dueño puede crear cuentas de Dueño o Admin.' });
  }

  // Las cuentas del taller (tecnico, supervisor del taller) tambien las da de alta solo el Dueño.
  if (ROLES_DEL_TALLER.includes(rol) && req.usuario.rol !== 'dueño') {
    return res.status(403).json({ error: 'Solo el Dueño puede crear cuentas del taller.' });
  }

  if (rol !== 'dueño' && !empresa_id) {
    return res.status(400).json({ error: 'La empresa es requerida.' });
  }

  let empresaSlug = null;
  if (empresa_id) {
    const { rows } = await pool.query('SELECT slug FROM empresas WHERE id = $1', [empresa_id]);
    empresaSlug = rows[0]?.slug ?? null;
  }
  if (ROLES_DEL_TALLER.includes(rol) && empresaSlug !== 'cityphone') {
    return res.status(400).json({ error: 'El taller de reparación es de CityPhone.' });
  }
  // 'admin' necesita sucursal solo cuando es de CityPhone — el mismo rol
  // tambien sirve como Supervisor de Áurea, que no tiene sucursales.
  const necesitaSucursal = ROLES_CITYPHONE_CON_SUCURSAL.includes(rol) || (rol === 'admin' && empresaSlug === 'cityphone');
  if (necesitaSucursal && !sucursal_id) {
    return res.status(400).json({ error: 'La sucursal es requerida.' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO usuarios (nombre, telefono, email, rol, sucursal_id, empresa_id, pin_hash, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, nombre, telefono, email, rol, sucursal_id, empresa_id, activo, created_at`,
      // Dueño y personal del taller no llevan sucursal (el taller es uno solo, compartido).
      [nombre.trim(), telefono || null, correo, rol, rol === 'dueño' || ROLES_DEL_TALLER.includes(rol) ? null : sucursal_id || null, rol === 'dueño' ? null : empresa_id, credencial.pin_hash, credencial.password_hash]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ese correo ya está en uso por otra cuenta.' });
    throw err;
  }
});

router.patch('/:id', async (req, res) => {
  const { nombre, telefono, email, rol, sucursal_id, empresa_id, activo } = req.body ?? {};
  if (rol && !ROLES_VALIDOS.includes(rol)) return res.status(400).json({ error: 'Rol inválido.' });
  if (rol && (rol === 'dueño' || rol === 'admin') && req.usuario.rol !== 'dueño') {
    return res.status(403).json({ error: 'Solo el Dueño puede asignar Dueño o Admin.' });
  }
  if (rol && ROLES_DEL_TALLER.includes(rol) && req.usuario.rol !== 'dueño') {
    return res.status(403).json({ error: 'Solo el Dueño puede asignar cuentas del taller.' });
  }

  const actual = (await pool.query('SELECT rol, sucursal_id FROM usuarios WHERE id = $1', [req.params.id])).rows[0];
  if (!actual) return res.status(404).json({ error: 'Usuario no encontrado.' });
  const rolFinal = rol ?? actual.rol;
  // El personal del taller nunca lleva sucursal (aunque llegue una en la peticion).
  const sucursalFinal = ROLES_DEL_TALLER.includes(rolFinal) ? null : sucursal_id;
  // Al pasar a un rol que necesita sucursal (ej. de tecnico a vendedor) hay que indicarla.
  if (rol && rol !== actual.rol && ROLES_CITYPHONE_CON_SUCURSAL.includes(rol) && !(sucursal_id ?? actual.sucursal_id)) {
    return res.status(400).json({ error: 'La sucursal es requerida.' });
  }

  let correo;
  if (email !== undefined) {
    correo = email ? normalizarCorreo(email) : null;
    if (correo && !esCorreoValido(correo)) return res.status(400).json({ error: 'El correo no es válido.' });
  }
  const fields = { nombre, telefono, email: correo, rol, sucursal_id: sucursalFinal, empresa_id, activo };
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
  let rows;
  try {
    ({ rows } = await pool.query(
      `UPDATE usuarios SET ${sets.join(', ')} WHERE id = $${i}
       RETURNING id, nombre, telefono, email, rol, sucursal_id, empresa_id, activo, created_at`,
      values
    ));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ese correo ya está en uso por otra cuenta.' });
    throw err;
  }
  if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado.' });
  res.json(rows[0]);
});

// El Administrador cambia la credencial de cualquiera; un Supervisor solo la de su propia empresa y nunca la de un
// Administrador ni la de otro Supervisor (antes no se revisaba: un Supervisor podia cambiar el PIN del Administrador).
function puedeGestionarCredenciales(quien, objetivo) {
  if (quien.rol === 'dueño') return true;
  return objetivo.rol !== 'dueño' && objetivo.rol !== 'admin' && objetivo.empresa_id === quien.empresa_id;
}

async function objetivoDeCredencial(req, res) {
  const objetivo = (await pool.query('SELECT id, rol, empresa_id FROM usuarios WHERE id = $1', [req.params.id])).rows[0];
  if (!objetivo) { res.status(404).json({ error: 'Usuario no encontrado.' }); return null; }
  if (!puedeGestionarCredenciales(req.usuario, objetivo)) {
    res.status(403).json({ error: 'No puedes cambiar la contraseña de esta cuenta.' });
    return null;
  }
  return objetivo;
}

// Nueva contraseña de una cuenta (reemplaza a "Restablecer PIN"). El PIN anterior deja de servir.
router.post('/:id/password', async (req, res) => {
  const { password } = req.body ?? {};
  if (!isValidPassword(password)) return res.status(400).json({ error: MENSAJE_PASSWORD });
  if (!(await objetivoDeCredencial(req, res))) return;

  await pool.query(
    `UPDATE usuarios SET password_hash = $1, pin_hash = $2, intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $3`,
    [hashPassword(password), hashInservible(), req.params.id]
  );
  res.json({ ok: true });
});

// Version anterior de la app: restablecer el PIN. Mientras el PIN y la contraseña sean lo mismo, se cambian juntos;
// si ya tiene una contraseña propia, esta no se toca.
router.post('/:id/pin', async (req, res) => {
  const { pin } = req.body ?? {};
  if (!isValidPin(pin)) return res.status(400).json({ error: 'El PIN debe ser de 4 dígitos.' });
  if (!(await objetivoDeCredencial(req, res))) return;

  await pool.query(
    `UPDATE usuarios
     SET pin_hash = $1,
         password_hash = CASE WHEN password_hash IS NULL OR password_hash = pin_hash THEN $1 ELSE password_hash END,
         intentos_fallidos = 0, bloqueado_hasta = NULL
     WHERE id = $2`,
    [hashPin(pin), req.params.id]
  );
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Eliminar un usuario (solo el Administrador). Para cuando alguien deja de trabajar aquí (despido,
// renuncia): la cuenta se borra (ya no puede entrar, desaparece de las listas), pero su historial
// (ventas, reparaciones, cortes de caja, nóminas...) NO se pierde — se conserva registrado a nombre de
// quien tú elijas (reasignar_a), igual que ya hace "Eliminar" en Sucursales con el historial de una
// sucursal. Es DEFINITIVO.
//
// Las tablas que apuntan a usuarios se descubren en el catalogo de Postgres, asi una tabla nueva no se
// queda sin mover. sesiones y notificaciones se borran (no son "historial", son solo su sesión propia).
// ─────────────────────────────────────────────────────────────────────────────

const ETIQUETA_TABLA_USUARIO = {
  ventas: 'ventas',
  cambios: 'cambios de producto',
  cortes_caja: 'cortes de caja',
  creditos: 'créditos autorizados',
  abonos: 'abonos de crédito',
  reparaciones: 'reparaciones asignadas',
  reparacion_abonos: 'cobros de reparación',
  reparacion_solicitudes_pieza: 'piezas solicitadas',
  reparacion_historial: 'movimientos en el historial de reparaciones',
  reparacion_traslados: 'traslados de reparación',
  nominas: 'nóminas',
  gastos: 'gastos registrados',
  cambios_equipo: 'cambios de equipo',
  ordenes_compra: 'órdenes de compra',
  movimientos_inventario: 'movimientos de inventario',
  movimientos_refacciones: 'movimientos de refacciones',
  apartados: 'apartados',
  fila_espera: 'fila de espera',
  auditoria: 'registros de auditoría',
  publicaciones: 'publicaciones',
  marketplace_listados: 'publicaciones de marketplace',
  comentarios_redes: 'comentarios respondidos',
  opciones_equipo: 'opciones de equipo creadas',
  aurea_ventas: 'ventas de Áurea',
  aurea_apartados: 'apartados de Áurea',
  aurea_apartado_abonos: 'abonos de apartado (Áurea)',
  aurea_cortes_caja: 'cortes de caja de Áurea',
  aurea_gastos: 'gastos de Áurea',
  aurea_movimientos_inventario: 'movimientos de inventario de Áurea',
};

async function tablasLigadasAUsuario(db) {
  const { rows } = await db.query(
    `SELECT c.conrelid::regclass::text AS tabla, a.attname AS columna
     FROM pg_constraint c
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND c.confrelid = 'usuarios'::regclass AND array_length(c.conkey, 1) = 1
     ORDER BY 1`
  );
  return rows.filter((r) => r.tabla !== 'sesiones' && r.tabla !== 'notificaciones');
}

async function historialDeUsuario(db, id) {
  const historial = [];
  for (const { tabla, columna } of await tablasLigadasAUsuario(db)) {
    const n = (await db.query(`SELECT count(*)::int AS n FROM ${tabla} WHERE ${columna} = $1`, [id])).rows[0].n;
    if (n > 0) historial.push({ tabla, etiqueta: ETIQUETA_TABLA_USUARIO[tabla] ?? tabla, cantidad: n });
  }
  return { historial, total_historial: historial.reduce((suma, h) => suma + h.cantidad, 0) };
}

// Qué se movería / borraría, para mostrarlo antes de confirmar.
router.get('/:id/impacto', requireRole('dueño'), async (req, res) => {
  const usuario = (await pool.query(`SELECT id, nombre, rol FROM usuarios WHERE id = $1`, [req.params.id])).rows[0];
  if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado.' });
  const otros = (await pool.query(`SELECT count(*)::int AS n FROM usuarios WHERE id <> $1 AND activo = true`, [req.params.id])).rows[0].n;
  res.json({ usuario, otros_usuarios_activos: otros, ...(await historialDeUsuario(pool, req.params.id)) });
});

router.delete('/:id', requireRole('dueño'), async (req, res) => {
  const { reasignar_a, confirmar } = req.body ?? {};
  if (req.params.id === req.usuario.sub) return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const usuario = (await client.query(`SELECT id, nombre, rol FROM usuarios WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!usuario) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }
    if (String(confirmar ?? '').trim() !== usuario.nombre.trim()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Escribe el nombre exacto del usuario para confirmar.' });
    }
    if (usuario.rol === 'dueño') {
      const otrosDuenos = (await client.query(`SELECT count(*)::int AS n FROM usuarios WHERE rol = 'dueño' AND id <> $1`, [usuario.id])).rows[0].n;
      if (otrosDuenos === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'No puedes eliminar al único Administrador.' });
      }
    }

    const { historial, total_historial } = await historialDeUsuario(client, usuario.id);
    let destino = null;
    if (total_historial > 0) {
      if (!reasignar_a) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Este usuario tiene historial: elige a quién se le reasigna para poder eliminarlo.',
          requiere_destino: true,
          historial,
        });
      }
      if (reasignar_a === usuario.id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'El destino tiene que ser otro usuario.' });
      }
      destino = (await client.query(`SELECT id, nombre FROM usuarios WHERE id = $1 AND activo = true`, [reasignar_a])).rows[0];
      if (!destino) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'El usuario destino no existe o está inactivo.' });
      }
    }

    // El historial pasa al destino elegido (o se queda sin dueño si nadie lo tiene, cosa que aquí no pasa: solo se
    // llega hasta aquí con destino cuando hay historial).
    if (destino) {
      for (const { tabla, columna } of await tablasLigadasAUsuario(client)) {
        await client.query(`UPDATE ${tabla} SET ${columna} = $2 WHERE ${columna} = $1`, [usuario.id, destino.id]);
      }
    }

    await client.query(`DELETE FROM sesiones WHERE usuario_id = $1`, [usuario.id]);
    await client.query(`DELETE FROM notificaciones WHERE usuario_id = $1`, [usuario.id]);
    await client.query(`DELETE FROM usuarios WHERE id = $1`, [usuario.id]);

    await client.query(
      `INSERT INTO auditoria (usuario_id, accion, entidad, entidad_id, datos_previos, datos_nuevos)
       VALUES ($1, 'eliminar', 'usuario', $2, $3, $4)`,
      [
        req.usuario.sub,
        usuario.id,
        JSON.stringify({ nombre: usuario.nombre, rol: usuario.rol }),
        JSON.stringify({ reasignado_a: destino?.nombre ?? null, historial }),
      ]
    );

    await client.query('COMMIT');
    res.json({ eliminado: true, nombre: usuario.nombre, reasignado_a: destino?.nombre ?? null, historial });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23503') {
      const ligada = /table "([^"]+)"/.exec(err.detail ?? '')?.[1] ?? 'otra tabla';
      return res.status(409).json({ error: `No se pudo eliminar: aún hay datos ligados (${ligada}). No se borró nada.` });
    }
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  } finally {
    client.release();
  }
});

module.exports = router;
