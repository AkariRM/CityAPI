// De una factura leida (XML o IA) a una propuesta de compra: reconoce al proveedor y los productos, calcula los costos
// con IVA tal como los espera Compras y avisa de lo que hay que revisar. Nada se guarda aqui: la persona confirma en la
// pantalla y la compra se registra con POST /compras como siempre.

const { TASA_IVA, calcularImporte, totalesCompra, redondear2 } = require('./compras');

const redondear4 = (n) => Math.round((n + Number.EPSILON) * 10000) / 10000;

function falla(statusCode, mensaje) {
  return Object.assign(new Error(mensaje), { statusCode });
}

// ---------------------------------------------------------------- texto
const PALABRAS_VACIAS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'e', 'en', 'con', 'para', 'por', 'un', 'una', 'pza', 'pzas', 'pieza', 'piezas', 'pz', 'color', 'mod', 'modelo']);

function sinAcentos(texto) {
  return String(texto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function tokens(texto) {
  const lista = sinAcentos(texto).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t.length >= 2 && !PALABRAS_VACIAS.has(t));
  return new Set(lista);
}

// Coeficiente de Dice entre dos conjuntos de palabras: 1 = iguales, 0 = nada en comun.
function dice(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let comunes = 0;
  for (const t of a) if (b.has(t)) comunes += 1;
  return (2 * comunes) / (a.size + b.size);
}

const normalizarNombre = (t) => sinAcentos(t).toLowerCase().replace(/\b(s\.?a\.? de c\.?v\.?|s\.? de r\.?l\.?( de c\.?v\.?)?|sa de cv|s a de c v)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

const RFC_RE = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;
const esRfc = (t) => typeof t === 'string' && RFC_RE.test(t.trim().toUpperCase());

const UNIDAD_CAJA_RE = /\b(caja|cajas|paquete|paquetes|pack|paq|kit|set|bulto|docena|xbx|xpk|dzn)\b/i;

// ---------------------------------------------------------------- factura de la IA
const numeroONull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const tasaIva = (v) => {
  const n = numeroONull(v);
  if (n === null) return null;
  return n > 1 ? n / 100 : n;
};

// La respuesta de n8n (ver CityPhone_Referencia_n8n_Endpoints_y_Webhooks.txt B7) -> la misma forma que deja leerCfdi, con los precios SIN
// IVA. La IA puede equivocarse: se valida todo y siempre se avisa que hay que revisarla.
function normalizarFacturaIA(cruda, advertenciasIA = []) {
  if (!cruda || typeof cruda !== 'object') throw falla(502, 'La IA no devolvió una factura que se pueda leer. Intenta con el XML o con otra foto más clara.');
  const advertencias = ['Leída con IA: revisa cada renglón contra la factura antes de registrar la compra.'];
  for (const a of Array.isArray(advertenciasIA) ? advertenciasIA : []) if (typeof a === 'string' && a.trim()) advertencias.push(a.trim().slice(0, 300));

  const crudos = Array.isArray(cruda.renglones) ? cruda.renglones : [];
  if (crudos.length === 0) throw falla(422, 'La IA no encontró productos en la factura. Prueba con el XML o con una foto más clara y completa.');
  if (crudos.length > 200) throw falla(422, 'La factura trae más de 200 renglones: divídela en varias compras.');

  const preciosConIva = cruda.precios_incluyen_iva === true;
  const subtotal = numeroONull(cruda.subtotal);
  const iva = numeroONull(cruda.iva);
  const tasaGlobal = iva !== null && iva > 0 && subtotal > 0 ? Math.round((iva / subtotal) * 100) / 100 : null;

  const renglones = [];
  crudos.forEach((r, i) => {
    const descripcion = typeof r?.descripcion === 'string' ? r.descripcion.trim().slice(0, 200) : '';
    const cantidad = numeroONull(r?.cantidad);
    const precio = numeroONull(r?.precio_unitario);
    if (!descripcion || !(cantidad > 0) || precio === null || precio < 0) {
      advertencias.push(`El renglón ${i + 1} de la factura no se pudo leer completo y se omitió.`);
      return;
    }
    const tasa = tasaIva(r.iva_tasa) ?? tasaGlobal ?? 0;
    const divisor = preciosConIva ? 1 + tasa : 1;
    const valorUnitario = precio / divisor;
    const importeCrudo = numeroONull(r.importe);
    const importe = importeCrudo !== null && importeCrudo >= 0 ? importeCrudo / divisor : cantidad * valorUnitario;
    const descuento = Math.max(0, numeroONull(r.descuento) ?? 0) / divisor;
    renglones.push({
      clave_sat: null,
      no_identificacion: typeof r.clave === 'string' && r.clave.trim() ? r.clave.trim().slice(0, 60) : null,
      descripcion,
      cantidad,
      unidad: typeof r.unidad === 'string' && r.unidad.trim() ? r.unidad.trim().slice(0, 30) : null,
      valor_unitario: redondear4(valorUnitario),
      importe: redondear4(importe),
      descuento: redondear4(descuento),
      iva_tasa: tasa,
      iva_exento: false,
      iva_importe: null,
    });
  });
  if (renglones.length === 0) throw falla(422, 'La IA no pudo leer ningún producto de la factura. Prueba con el XML o con una foto más clara.');

  const rfc = typeof cruda.proveedor?.rfc === 'string' ? cruda.proveedor.rfc.trim().toUpperCase() : null;
  if (rfc && !esRfc(rfc)) advertencias.push(`El RFC "${rfc}" leído no tiene el formato de un RFC y se ignoró.`);
  const fecha = typeof cruda.fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cruda.fecha.trim()) ? cruda.fecha.trim() : null;
  if (!fecha) advertencias.push('No se pudo leer la fecha de la factura: elígela a mano.');
  const total = numeroONull(cruda.total);

  return {
    origen: 'ia',
    version: null,
    uuid: typeof cruda.uuid === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cruda.uuid.trim()) ? cruda.uuid.trim().toUpperCase() : null,
    serie: null,
    folio: null,
    folio_factura: typeof cruda.folio === 'string' && cruda.folio.trim() ? cruda.folio.trim().slice(0, 60) : null,
    fecha,
    moneda: 'MXN',
    subtotal,
    descuento: numeroONull(cruda.descuento),
    total: total !== null && total >= 0 ? total : null,
    emisor: { rfc: rfc && esRfc(rfc) ? rfc : null, nombre: typeof cruda.proveedor?.nombre === 'string' && cruda.proveedor.nombre.trim() ? cruda.proveedor.nombre.trim().slice(0, 200) : null },
    receptor: { rfc: null, nombre: null },
    renglones,
    advertencias,
  };
}

// ---------------------------------------------------------------- renglones de la compra
// Compras captura costos "con IVA incluido" (se le quita 16% para el costo de cada pieza) o sin IVA. Con IVA en la factura
// se capturan los costos BRUTOS (con IVA) para que el total de la compra sea lo que realmente se pago y el costo de cada
// pieza salga sin IVA; sin IVA se capturan tal cual. Cantidades decimales (la compra solo admite enteras): se redondean y se
// ajusta el costo para conservar el importe de la factura.
function armarRenglones(factura) {
  const advertencias = [];
  const lineas = factura.renglones;
  const conIva = lineas.some((l) => l.iva_tasa > 0);
  const incluye_iva = conIva;
  if (conIva && lineas.some((l) => Math.abs(l.iva_tasa - TASA_IVA) > 0.0005)) {
    advertencias.push('La factura mezcla IVA de 16% con otra tasa o sin IVA: el costo de cada producto se calculó como si todo llevara 16%, así que el total puede diferir un poco del de la factura. Revísalo.');
  }
  const factor = incluye_iva ? 1 + TASA_IVA : 1;

  const renglones = lineas.map((l, i) => {
    const notas = [];
    let cantidad = Math.round(l.cantidad);
    if (cantidad < 1) cantidad = 1;
    if (Math.abs(l.cantidad - cantidad) > 1e-9) {
      notas.push(`La factura trae ${l.cantidad} en cantidad: se redondeó a ${cantidad} y se ajustó el costo para conservar el importe.`);
    }
    const bruto = l.importe * factor;
    const costo_unitario = redondear4(bruto / cantidad);
    const descuento_monto = redondear2((l.descuento ?? 0) * factor);
    const importe = calcularImporte({ cantidad, costo_unitario, descuento_pct: 0, descuento_monto });
    const unidad_es_caja = l.unidad ? UNIDAD_CAJA_RE.test(l.unidad) : false;
    if (unidad_es_caja) notas.push(`La unidad de la factura es "${l.unidad}": indica cuántas piezas trae cada una.`);
    if (importe < 0) notas.push('El descuento es mayor que el importe.');
    return {
      n: i + 1,
      descripcion: l.descripcion,
      no_identificacion: l.no_identificacion,
      unidad: l.unidad,
      unidad_es_caja,
      cantidad,
      cantidad_factura: l.cantidad,
      costo_unitario,
      descuento_monto,
      importe,
      notas,
    };
  });

  const totales = totalesCompra(renglones.map((r) => r.importe), incluye_iva ? TASA_IVA : 0);
  const totalFactura = factura.total;
  const diferencia = totalFactura === null ? null : redondear2(totales.total - totalFactura);
  if (diferencia !== null && Math.abs(diferencia) > 1) {
    advertencias.push(`El total calculado (${dinero(totales.total)}) no coincide con el total de la factura (${dinero(totalFactura)}): revisa cantidades, descuentos e IVA.`);
  }
  return { incluye_iva, renglones, totales: { calculado: totales.total, factura: totalFactura, diferencia }, advertencias };
}

function dinero(n) {
  return `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ---------------------------------------------------------------- proveedor
async function sugerirProveedor(queryable, emisor) {
  const { rows } = await queryable.query(`SELECT id, nombre, rfc FROM proveedores WHERE activo`);
  if (emisor?.rfc) {
    const porRfc = rows.find((p) => p.rfc && p.rfc.trim().toUpperCase() === emisor.rfc);
    if (porRfc) return { id: porRfc.id, nombre: porRfc.nombre, motivo: 'rfc' };
  }
  const buscado = normalizarNombre(emisor?.nombre);
  if (!buscado) return null;
  const exacto = rows.filter((p) => normalizarNombre(p.nombre) === buscado);
  if (exacto.length === 1) return { id: exacto[0].id, nombre: exacto[0].nombre, motivo: 'nombre' };
  if (exacto.length > 1) return null;
  const tokensBuscado = tokens(buscado);
  const candidatos = rows
    .map((p) => ({ p, score: dice(tokensBuscado, tokens(normalizarNombre(p.nombre))) }))
    .filter((c) => c.score >= 0.75)
    .sort((x, y) => y.score - x.score);
  if (candidatos.length > 0 && (candidatos.length === 1 || candidatos[0].score - candidatos[1].score >= 0.1)) {
    return { id: candidatos[0].p.id, nombre: candidatos[0].p.nombre, motivo: 'nombre' };
  }
  return null;
}

// ---------------------------------------------------------------- productos
const MIN_SUGERENCIA = 0.6;
const MIN_ALTERNATIVA = 0.35;

async function sugerirProductos(queryable, renglones, proveedorId) {
  const { rows: productos } = await queryable.query(
    `SELECT p.id, p.nombre, p.sku, p.marca, p.modelo, p.color, p.costo, p.precio_venta, p.precio_mayoreo, p.precio_revendedor,
            COALESCE((SELECT sum(stock_cantidad) FROM inventario WHERE producto_id = p.id), 0)::int AS stock_total
     FROM productos p WHERE p.activo AND p.tipo = 'accesorio'`
  );
  const claves = proveedorId
    ? (await queryable.query(`SELECT producto_id, clave FROM producto_proveedor_claves WHERE proveedor_id = $1`, [proveedorId])).rows
    : [];
  const porId = new Map(productos.map((p) => [p.id, p]));
  const tokensProducto = productos.map((p) => ({ p, t: tokens([p.nombre, p.marca, p.modelo, p.color].filter(Boolean).join(' ')) }));

  const publico = (p, motivo, score) => ({
    id: p.id, nombre: p.nombre, sku: p.sku, costo: Number(p.costo) || 0, stock_total: p.stock_total,
    precio_venta: p.precio_venta === null ? null : Number(p.precio_venta), motivo, score: Math.round(score * 100) / 100,
  });

  return renglones.map((r) => {
    const llave = r.no_identificacion ? r.no_identificacion.trim().toLowerCase() : '';
    let sugerido = null;
    if (llave) {
      const porClave = claves.find((k) => k.clave && k.clave.trim().toLowerCase() === llave);
      if (porClave && porId.get(porClave.producto_id)) sugerido = publico(porId.get(porClave.producto_id), 'clave', 1);
      if (!sugerido) {
        const porSku = productos.find((p) => p.sku && p.sku.trim().toLowerCase() === llave);
        if (porSku) sugerido = publico(porSku, 'sku', 0.95);
      }
    }
    const buscado = tokens(r.descripcion);
    const ordenados = tokensProducto
      .map(({ p, t }) => ({ p, score: dice(buscado, t) }))
      .filter((c) => c.score >= MIN_ALTERNATIVA)
      .sort((x, y) => y.score - x.score);
    if (!sugerido && ordenados.length > 0 && ordenados[0].score >= MIN_SUGERENCIA && (ordenados.length === 1 || ordenados[0].score - ordenados[1].score >= 0.08)) {
      sugerido = publico(ordenados[0].p, 'nombre', ordenados[0].score);
    }
    const alternativas = ordenados.filter((c) => !sugerido || c.p.id !== sugerido.id).slice(0, 3).map((c) => publico(c.p, 'nombre', c.score));
    return { producto_sugerido: sugerido, alternativas };
  });
}

// ---------------------------------------------------------------- duplicados
async function buscarDuplicada(queryable, { uuid, proveedorId, folio }) {
  if (uuid) {
    const { rows } = await queryable.query(`SELECT id, folio FROM compras WHERE lower(uuid_factura) = lower($1) AND estado = 'registrada' LIMIT 1`, [uuid]);
    if (rows[0]) return { compra_id: rows[0].id, folio: rows[0].folio, motivo: 'uuid' };
  }
  if (proveedorId && folio) {
    const { rows } = await queryable.query(
      `SELECT id, folio FROM compras WHERE proveedor_id = $1 AND lower(folio_proveedor) = lower($2) AND estado = 'registrada' LIMIT 1`,
      [proveedorId, folio]
    );
    if (rows[0]) return { compra_id: rows[0].id, folio: rows[0].folio, motivo: 'folio' };
  }
  return null;
}

// ---------------------------------------------------------------- todo junto
async function construirPropuesta(queryable, factura) {
  const proveedor = await sugerirProveedor(queryable, factura.emisor);
  const armado = armarRenglones(factura);
  const sugerencias = await sugerirProductos(queryable, armado.renglones, proveedor?.id ?? null);
  const duplicada = await buscarDuplicada(queryable, { uuid: factura.uuid, proveedorId: proveedor?.id ?? null, folio: factura.folio_factura });
  return {
    origen: factura.origen,
    factura: {
      uuid: factura.uuid, folio_factura: factura.folio_factura, fecha: factura.fecha, subtotal: factura.subtotal, total: factura.total, moneda: factura.moneda,
    },
    emisor: factura.emisor,
    proveedor_sugerido: proveedor,
    incluye_iva: armado.incluye_iva,
    renglones: armado.renglones.map((r, i) => ({ ...r, ...sugerencias[i] })),
    totales: armado.totales,
    duplicada,
    advertencias: [...factura.advertencias, ...armado.advertencias],
  };
}

module.exports = {
  normalizarFacturaIA, armarRenglones, sugerirProveedor, sugerirProductos, buscarDuplicada, construirPropuesta,
  tokens, dice, esRfc, normalizarNombre, sinAcentos,
};
