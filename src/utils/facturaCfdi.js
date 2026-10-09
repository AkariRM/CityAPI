// Lector de facturas electronicas (CFDI) del SAT en XML, sin dependencias. Soporta CFDI 4.0 y 3.3, y de forma basica 3.2.
// No usa IA: el XML trae todo estructurado. Devuelve la factura ya normalizada, en la misma forma que la que arma la
// lectura con IA de PDF y fotos (ver facturaPropuesta.js).

function falla(statusCode, mensaje) {
  return Object.assign(new Error(mensaje), { statusCode });
}

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodificarEntidades(texto) {
  return texto.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (todo, e) => {
    if (e[0] === '#') {
      const codigo = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(codigo) && codigo > 0 && codigo < 0x110000 ? String.fromCodePoint(codigo) : todo;
    }
    return ENTIDADES[e] ?? todo;
  });
}

// Los atributos se guardan con el nombre en minusculas y sin prefijo (el 3.2 los trae en camelCase y el 3.3/4.0 en
// PascalCase), sin los xmlns.
function leerAtributos(texto) {
  const atributos = {};
  const re = /([^\s=\/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(texto))) {
    const nombre = m[1];
    if (nombre === 'xmlns' || nombre.startsWith('xmlns:')) continue;
    const local = (nombre.includes(':') ? nombre.split(':').pop() : nombre).toLowerCase();
    atributos[local] = decodificarEntidades(m[2] ?? m[3] ?? '').trim();
  }
  return atributos;
}

// XML -> arbol { nombre (sin prefijo, en minusculas), atributos, hijos }. Solo etiquetas y atributos: el texto entre
// etiquetas no se usa en un CFDI. Rechaza DOCTYPE/ENTITY (nada de entidades externas ni expansiones).
function parsearXml(texto) {
  const xml = String(texto ?? '').replace(/^﻿/, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw falla(400, 'El XML no es válido: no se permiten definiciones DOCTYPE.');
  const limpio = xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const raiz = { nombre: '#raiz', completo: '#raiz', atributos: {}, hijos: [] };
  const pila = [raiz];
  const re = /<(\/?)([A-Za-z_][\w.\-]*(?::[\w.\-]+)?)((?:\s+[^\s=\/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let m;
  while ((m = re.exec(limpio))) {
    const [, cierre, completo, atributosTexto, autocierre] = m;
    if (cierre) {
      const tope = pila.pop();
      if (!tope || tope.completo !== completo || pila.length === 0) throw falla(400, 'El XML no es válido (etiquetas mal cerradas).');
    } else {
      const nodo = {
        nombre: (completo.includes(':') ? completo.split(':').pop() : completo).toLowerCase(),
        completo,
        atributos: leerAtributos(atributosTexto),
        hijos: [],
      };
      pila[pila.length - 1].hijos.push(nodo);
      if (!autocierre) pila.push(nodo);
    }
  }
  if (pila.length !== 1 || raiz.hijos.length === 0) throw falla(400, 'El XML no es válido o está incompleto.');
  return raiz.hijos[0];
}

const hijosDe = (nodo, nombre) => nodo.hijos.filter((h) => h.nombre === nombre);
function descendientes(nodo, nombre, salida = []) {
  for (const h of nodo.hijos) {
    if (h.nombre === nombre) salida.push(h);
    descendientes(h, nombre, salida);
  }
  return salida;
}

function numero(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = Number(String(valor).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

const redondear2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const redondear4 = (n) => Math.round((n + Number.EPSILON) * 10000) / 10000;

const TIPOS_NO_COMPRA = {
  E: 'una nota de crédito (egreso), que no es una compra',
  P: 'un complemento de pago, que no es una compra',
  T: 'un comprobante de traslado, que no es una compra',
  N: 'un recibo de nómina, que no es una compra',
};

// Tasa de IVA de un concepto: { tasa, importe, exento }. En 3.3/4.0 va dentro de cada Concepto; en 3.2 solo a nivel de
// comprobante (se aplica a todos los renglones).
function ivaDelConcepto(concepto, tasaGlobal) {
  const traslados = descendientes(concepto, 'traslado').filter((t) => t.atributos.impuesto === '002' || /^iva$/i.test(t.atributos.impuesto ?? ''));
  if (traslados.length === 0) return { tasa: tasaGlobal ?? 0, importe: null, exento: false };
  let tasa = null;
  let importe = 0;
  let exento = true;
  for (const t of traslados) {
    if ((t.atributos.tipofactor ?? '').toLowerCase() === 'exento') continue;
    exento = false;
    const tasaRaw = numero(t.atributos.tasaocuota ?? t.atributos.tasa);
    if (tasaRaw !== null && tasa === null) tasa = tasaRaw > 1 ? tasaRaw / 100 : tasaRaw;
    const imp = numero(t.atributos.importe);
    if (imp !== null) importe += imp;
  }
  return { tasa: tasa ?? 0, importe: exento ? 0 : redondear2(importe), exento };
}

// texto del XML -> factura normalizada (o lanza un error 400 con un mensaje que se le puede mostrar a la persona).
function leerCfdi(texto) {
  const raiz = parsearXml(texto);
  if (raiz.nombre !== 'comprobante') throw falla(400, 'El archivo XML no es una factura electrónica (CFDI) del SAT.');
  const a = raiz.atributos;
  const advertencias = [];

  const tipoRaw = (a.tipodecomprobante ?? '').trim();
  const tipo = /^ingreso$/i.test(tipoRaw) ? 'I' : tipoRaw.toUpperCase();
  if (tipo && tipo !== 'I') {
    throw falla(400, `Esta factura es ${TIPOS_NO_COMPRA[tipo] ?? `de tipo "${tipo}"`}: sube la factura de la compra (tipo ingreso).`);
  }

  const conceptosNodo = descendientes(raiz, 'concepto');
  if (conceptosNodo.length === 0) throw falla(400, 'La factura no trae conceptos (productos).');
  if (conceptosNodo.length > 200) throw falla(400, 'La factura trae más de 200 conceptos: divídela en varias compras.');

  // CFDI 3.2: el IVA va solo a nivel de comprobante.
  let tasaGlobal = null;
  const impuestosComprobante = hijosDe(raiz, 'impuestos')[0];
  if (impuestosComprobante && (a.version ?? '').startsWith('3.2')) {
    const iva = descendientes(impuestosComprobante, 'traslado').find((t) => /^iva$/i.test(t.atributos.impuesto ?? '') || t.atributos.impuesto === '002');
    const tasaRaw = numero(iva?.atributos.tasa ?? iva?.atributos.tasaocuota);
    if (tasaRaw !== null) tasaGlobal = tasaRaw > 1 ? tasaRaw / 100 : tasaRaw;
  }

  const moneda = (a.moneda ?? 'MXN').toUpperCase();
  let factor = 1;
  if (moneda !== 'MXN' && moneda !== 'MXP') {
    const tipoCambio = numero(a.tipocambio);
    if (!(tipoCambio > 0)) throw falla(400, `La factura está en ${moneda} y no trae el tipo de cambio: captura la compra a mano.`);
    factor = tipoCambio;
    advertencias.push(`La factura está en ${moneda}: los montos se convirtieron a pesos con el tipo de cambio ${tipoCambio}.`);
  }
  const aPesos = (n) => (n === null ? null : redondear4(n * factor));

  const renglones = conceptosNodo.map((c, i) => {
    const ca = c.atributos;
    const cantidad = numero(ca.cantidad);
    const valorUnitario = numero(ca.valorunitario);
    const importe = numero(ca.importe);
    if (!(cantidad > 0) || valorUnitario === null) throw falla(400, `El concepto ${i + 1} de la factura no trae cantidad o valor unitario.`);
    const iva = ivaDelConcepto(c, tasaGlobal);
    return {
      clave_sat: ca.claveprodserv || null,
      no_identificacion: ca.noidentificacion || null,
      descripcion: ca.descripcion || `Concepto ${i + 1}`,
      cantidad,
      unidad: ca.unidad || ca.claveunidad || null,
      valor_unitario: aPesos(valorUnitario),
      importe: aPesos(importe ?? cantidad * valorUnitario),
      descuento: aPesos(numero(ca.descuento) ?? 0),
      iva_tasa: iva.tasa,
      iva_exento: iva.exento,
      iva_importe: iva.importe === null ? null : aPesos(iva.importe),
    };
  });

  const timbre = descendientes(raiz, 'timbrefiscaldigital')[0];
  const uuid = timbre?.atributos.uuid ? timbre.atributos.uuid.toUpperCase() : null;
  if (!uuid) advertencias.push('La factura no trae timbre fiscal (UUID): no se podrá evitar registrarla dos veces por su UUID.');

  const emisor = hijosDe(raiz, 'emisor')[0];
  const receptor = hijosDe(raiz, 'receptor')[0];
  const serie = a.serie || null;
  const folio = a.folio || null;
  const fecha = /^\d{4}-\d{2}-\d{2}/.test(a.fecha ?? '') ? a.fecha.slice(0, 10) : null;
  if (!fecha) advertencias.push('No se pudo leer la fecha de la factura: elígela a mano.');

  return {
    origen: 'xml',
    version: a.version || null,
    uuid,
    serie,
    folio,
    folio_factura: [serie, folio].filter(Boolean).join('-') || null,
    fecha,
    moneda: 'MXN',
    subtotal: aPesos(numero(a.subtotal)),
    descuento: aPesos(numero(a.descuento)),
    total: aPesos(numero(a.total)),
    emisor: { rfc: emisor?.atributos.rfc ? emisor.atributos.rfc.toUpperCase() : null, nombre: emisor?.atributos.nombre || null },
    receptor: { rfc: receptor?.atributos.rfc ? receptor.atributos.rfc.toUpperCase() : null, nombre: receptor?.atributos.nombre || null },
    renglones,
    advertencias,
  };
}

module.exports = { leerCfdi, parsearXml, falla };
