// Calculos de Compras de inventario, sin base de datos: los usan tanto la vista previa como el guardado
// (compras.routes.js) para que nunca den resultados distintos.

const TASA_IVA = 0.16;

const redondear2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const redondear4 = (n) => Math.round((n + Number.EPSILON) * 10000) / 10000;

// Lo que se paga por un renglon: cantidad x costo, menos el descuento en % y luego el descuento en pesos
// (monto fijo del renglon completo, no por pieza).
function calcularImporte({ cantidad, costo_unitario, descuento_pct = 0, descuento_monto = 0 }) {
  const bruto = cantidad * costo_unitario;
  return redondear2(bruto * (1 - descuento_pct / 100) - descuento_monto);
}

// Costo de UNA pieza sin IVA y con descuento: el que entra al promedio. Si los costos capturados ya traen
// IVA (iva_tasa > 0) se le quita; si no, se toma tal cual.
function calcularCostoPieza({ importe, piezas, iva_tasa = 0 }) {
  const sinIva = iva_tasa > 0 ? importe / (1 + iva_tasa) : importe;
  return redondear4(sinIva / piezas);
}

// Costo promedio ponderado movil del producto (todas las sucursales juntas, porque el costo es del
// producto). Sin historial confiable (sin stock o con costo 0, o sea nunca capturado) el nuevo costo es
// el de la compra: promediar contra un cero falso lo bajaria sin razon.
function calcularCostoPromedio({ stock_antes, costo_antes, piezas, costo_pieza }) {
  if (!(stock_antes > 0) || !(costo_antes > 0)) return redondear2(costo_pieza);
  return redondear2((stock_antes * costo_antes + piezas * costo_pieza) / (stock_antes + piezas));
}

// Redondea un precio al multiplo pedido (5 = a $5) hacia arriba, abajo o al mas cercano. multiplo 0 = solo
// centavos. Se hace en centavos enteros para que 12.50 / 5 no se vea afectado por decimales binarios.
function redondearPrecio(valor, multiplo, direccion = 'arriba') {
  const centavos = Math.round(valor * 100);
  const paso = Math.round((Number(multiplo) || 0) * 100);
  if (paso <= 0) return centavos / 100;
  const cociente = centavos / paso;
  const veces = direccion === 'abajo' ? Math.floor(cociente + 1e-9) : direccion === 'cercano' ? Math.round(cociente) : Math.ceil(cociente - 1e-9);
  return (veces * paso) / 100;
}

// Conserva la proporcion precio/costo que tenia un precio (equivale a conservar su margen, sobre costo o
// sobre precio): nuevo = costo_despues x (precio_antes / costo_antes). Devuelve null cuando el precio NO
// debe cambiar: no hay precio, no habia costo anterior (sin proporcion que conservar) o el costo no se
// movio -- en ese caso no se redondea, para que una compra al mismo costo no mueva precios como $149.99.
function recalcularPrecio({ precio_antes, costo_antes, costo_despues, multiplo, direccion }) {
  if (precio_antes === null || precio_antes === undefined || !(Number(precio_antes) > 0)) return null;
  if (!(costo_antes > 0)) return null;
  if (Math.abs(costo_despues - costo_antes) < 0.005) return null;
  const nuevo = redondearPrecio(costo_despues * (Number(precio_antes) / costo_antes), multiplo, direccion);
  return Math.abs(nuevo - Number(precio_antes)) < 0.005 ? null : nuevo;
}

// Plan de un renglon a partir del estado actual del producto. `producto` trae costo, precio_venta,
// precio_mayoreo, precio_revendedor y stock_total (suma de todas las sucursales). Devuelve todo lo que
// se guarda en compra_items y lo que cambia en el producto.
function planificarRenglon({ item, producto, iva_tasa, precios_modo, redondeo_multiplo, redondeo_direccion }) {
  const piezas_por_unidad = item.piezas_por_unidad ?? 1;
  const piezas = item.cantidad * piezas_por_unidad;
  const importe = calcularImporte(item);
  const costo_pieza = calcularCostoPieza({ importe, piezas, iva_tasa });
  const stock_antes = Number(producto.stock_total) || 0;
  const costo_antes = Number(producto.costo) || 0;
  const costo_despues = calcularCostoPromedio({ stock_antes, costo_antes, piezas, costo_pieza });

  const cambiaPrecios = precios_modo === 'margen' && item.actualizar_precios !== false;
  const nuevo = (campo) => {
    const antes = producto[campo] === null || producto[campo] === undefined ? null : Number(producto[campo]);
    if (!cambiaPrecios) return { antes, despues: antes };
    const recalculado = recalcularPrecio({ precio_antes: antes, costo_antes, costo_despues, multiplo: redondeo_multiplo, direccion: redondeo_direccion });
    return { antes, despues: recalculado ?? antes };
  };
  const publico = nuevo('precio_venta');
  const mayoreo = nuevo('precio_mayoreo');
  const revendedor = nuevo('precio_revendedor');

  return {
    piezas_por_unidad,
    piezas,
    importe,
    costo_pieza,
    stock_antes,
    costo_antes,
    costo_despues,
    precio_antes: publico.antes,
    precio_despues: publico.despues,
    mayoreo_antes: mayoreo.antes,
    mayoreo_despues: mayoreo.despues,
    revendedor_antes: revendedor.antes,
    revendedor_despues: revendedor.despues,
  };
}

// Totales de la compra: total = lo que se paga (suma de importes tal como se capturaron), subtotal = ese
// total sin IVA (igual al total cuando los costos no traen IVA).
function totalesCompra(importes, iva_tasa = 0) {
  const total = redondear2(importes.reduce((suma, n) => suma + n, 0));
  const subtotal = iva_tasa > 0 ? redondear2(total / (1 + iva_tasa)) : total;
  return { total, subtotal, iva: redondear2(total - subtotal) };
}

module.exports = {
  TASA_IVA,
  redondear2,
  calcularImporte,
  calcularCostoPieza,
  calcularCostoPromedio,
  redondearPrecio,
  recalcularPrecio,
  planificarRenglon,
  totalesCompra,
};
