// Piezas compartidas por los endpoints que usa el agente de WhatsApp (Michelle, de TRAI): telefonos y quien es la persona que escribe.

// Ultimos 10 digitos del telefono, o null si no hay 10 (mismo criterio que contacto-externo y reparacion-externa: WhatsApp manda
// E.164, aqui se captura en texto libre).
function ultimosDiezDigitos(telefono) {
  const digitos = String(telefono ?? '').replace(/\D/g, '').slice(-10);
  return digitos.length === 10 ? digitos : null;
}

// Texto recortado y con un maximo de caracteres, o null si viene vacio o no es texto.
function textoLimpio(valor, max) {
  if (typeof valor !== 'string') return null;
  const t = valor.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

// Quien es la persona de ese telefono: personal activo, cliente (telefono principal o adicional) o prospecto del agente.
// null si no se conoce. El personal se revisa primero (igual que contacto-externo).
async function identificarContacto(db, telefono10) {
  const personal = await db.query(
    `SELECT id, nombre FROM usuarios WHERE activo = true AND right(regexp_replace(telefono, '\\D', '', 'g'), 10) = $1 LIMIT 1`,
    [telefono10]
  );
  if (personal.rows[0]) return { tipo: 'personal', id: personal.rows[0].id, nombre: personal.rows[0].nombre };

  const cliente = await db.query(
    `SELECT id, nombre FROM clientes
     WHERE right(regexp_replace(telefono, '\\D', '', 'g'), 10) = $1 OR right(regexp_replace(telefono_adicional, '\\D', '', 'g'), 10) = $1
     ORDER BY (right(regexp_replace(telefono, '\\D', '', 'g'), 10) = $1) DESC NULLS LAST, created_at ASC LIMIT 1`,
    [telefono10]
  );
  if (cliente.rows[0]) return { tipo: 'cliente', id: cliente.rows[0].id, nombre: cliente.rows[0].nombre };

  const prospecto = await db.query(`SELECT id, nombre FROM agente_prospectos WHERE telefono10 = $1`, [telefono10]);
  if (prospecto.rows[0]) return { tipo: 'prospecto', id: prospecto.rows[0].id, nombre: prospecto.rows[0].nombre };
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Fecha YYYY-MM-DD valida (o null si no lo es).
function fechaISO(valor) {
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor.trim())) return null;
  const f = new Date(`${valor.trim()}T00:00:00Z`);
  return Number.isNaN(f.getTime()) || f.toISOString().slice(0, 10) !== valor.trim() ? null : valor.trim();
}

module.exports = { ultimosDiezDigitos, textoLimpio, identificarContacto, fechaISO, UUID };
