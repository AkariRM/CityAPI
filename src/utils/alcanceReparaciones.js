// Que reparaciones puede ver/operar cada rol (taller de reparacion compartido por todas las
// sucursales). Devuelve { sucursalId } (solo las recibidas en esa sucursal), { tecnicoId } (solo las
// asignadas a ese tecnico), {} (todas) o { sinAcceso: true }.
//
//  - dueño y supervisor_taller: todas.
//  - tecnico: las que tiene asignadas (el taller ve solo el taller).
//  - vendedor y admin (Supervisor de sucursal): las de SU sucursal (usuarios.sucursal_id) -- quien
//    recibe el equipo es quien lo entrega y cobra. Sin sucursal asignada no ven nada (falla cerrado).
function alcanceReparaciones(usuario) {
  switch (usuario?.rol) {
    case 'dueño':
    case 'supervisor_taller':
      return {};
    case 'tecnico':
      return { tecnicoId: usuario.sub };
    case 'admin':
    case 'vendedor':
      return usuario.sucursal_id ? { sucursalId: usuario.sucursal_id } : { sinAcceso: true };
    default:
      return { sinAcceso: true };
  }
}

// Roles del taller (no tratan con clientes, dinero ni catalogo de venta).
const esPersonalTaller = (rol) => rol === 'tecnico' || rol === 'supervisor_taller';

module.exports = { alcanceReparaciones, esPersonalTaller };
