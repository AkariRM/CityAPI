// Que reparaciones puede ver/operar cada rol (taller de reparacion compartido por todas las
// sucursales). Devuelve un objeto con los limites que aplican (todos opcionales):
//   sucursalId        solo las recibidas en esa sucursal
//   tecnicoId         solo las asignadas a ese tecnico
//   recibidaEnTaller  solo las que el taller ya recibio alguna vez (en_taller_desde)
//   soloTaller        las que el taller ya recibio o van en camino a el (para recibirlas)
//   sinAcceso         no ve ninguna
//
//  - dueño: todas.
//  - supervisor_taller: las que ya estan en el taller o van hacia el (las recibe y las asigna).
//  - tecnico: las que tiene asignadas Y que el taller ya recibio (no ve lo que aun no le llega).
//  - vendedor y admin (Supervisor de sucursal): las de SU sucursal (usuarios.sucursal_id) -- quien
//    recibe el equipo es quien lo entrega y cobra, y lo sigue en todo su recorrido. Sin sucursal
//    asignada no ven nada (falla cerrado).
function alcanceReparaciones(usuario) {
  switch (usuario?.rol) {
    case 'dueño':
      return {};
    case 'supervisor_taller':
      return { soloTaller: true };
    case 'tecnico':
      return { tecnicoId: usuario.sub, recibidaEnTaller: true };
    case 'admin':
    case 'vendedor':
      return usuario.sucursal_id ? { sucursalId: usuario.sucursal_id } : { sinAcceso: true };
    default:
      return { sinAcceso: true };
  }
}

// ¿Esta reparacion ({ tecnico_id, sucursal_id, en_taller_desde, ubicacion }) queda dentro del alcance?
function enAlcance(alcance, r) {
  if (alcance.sinAcceso) return false;
  if (alcance.tecnicoId && r.tecnico_id !== alcance.tecnicoId) return false;
  if (alcance.sucursalId && r.sucursal_id !== alcance.sucursalId) return false;
  if (alcance.recibidaEnTaller && !r.en_taller_desde) return false;
  if (alcance.soloTaller && !(r.en_taller_desde || r.ubicacion === 'en_transito_taller')) return false;
  return true;
}

// Condicion SQL (texto fijo, sin datos del usuario) para los limites que no se mandan como
// parametro: se agrega con AND a un WHERE. alias = alias de la tabla reparaciones en la consulta.
function sqlAlcance(alcance, alias = 'r') {
  if (alcance.recibidaEnTaller) return ` AND ${alias}.en_taller_desde IS NOT NULL`;
  if (alcance.soloTaller) return ` AND (${alias}.en_taller_desde IS NOT NULL OR ${alias}.ubicacion = 'en_transito_taller')`;
  return '';
}

// Roles del taller (no tratan con clientes, dinero ni catalogo de venta).
const esPersonalTaller = (rol) => rol === 'tecnico' || rol === 'supervisor_taller';

module.exports = { alcanceReparaciones, enAlcance, sqlAlcance, esPersonalTaller };
