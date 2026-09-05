// Deriva marca/categoria/almacenamiento/bateria de texto libre SOLO cuando
// el dato real (columna) esta vacio — nunca sobreescribe lo que ya esta
// capturado a mano o por el importador. Pensado para el catalogo externo
// que consume el agente de WhatsApp (TRAI): sin esto, "13" mezclaba iPhone,
// Xiaomi y Huawei sin forma de distinguirlos.
//
// No intenta adivinar el "modelo" exacto por texto — es demasiado variado
// entre marcas para hacerlo con confianza. Cuando falta, se usa el nombre
// completo del producto como modelo (ya es descriptivo de por si, ej.
// "APPLE 15 PRO LIBRE 256GB ESIM").

const REGLAS_MARCA = [
  [/\bIPHONE\b/i, 'APPLE'],
  [/\bIPAD\b/i, 'APPLE'],
  [/\bIWATCH\b|\bAPPLE\s*WATCH\b/i, 'APPLE'],
  [/\bMACBOOK\b/i, 'APPLE'],
  [/\bAIRPODS\b/i, 'APPLE'],
  [/\bAPPLE\b/i, 'APPLE'],
  [/\bSAMSUNG\b/i, 'SAMSUNG'],
  [/\bXIAOMI\b|\bREDMI\b|\bPOCO\b/i, 'XIAOMI'],
  [/\bHUAWEI\b/i, 'HUAWEI'],
  [/\bMOTOROLA\b|\bMOTO\s/i, 'MOTOROLA'],
  [/\bGOOGLE\b|\bPIXEL\b/i, 'GOOGLE'],
  [/\bLENOVO\b/i, 'LENOVO'],
  [/\bOURA\b/i, 'OURA'],
  [/\bUMIIO\b/i, 'UMIIO'],
];

const REGLAS_CATEGORIA_DISPOSITIVO = [
  [/\bIPAD\b|\bTAB(LET)?\b/i, 'TABLET'],
  [/\bMACBOOK\b|\bLAPTOP\b|\bNOTEBOOK\b|\bIDEA\s*TAB\s*PLUS\b/i, 'LAPTOP'],
  [/\bIWATCH\b|\bWATCH\b|\bAIRPODS\b|\bRING\b|\bFREE\s*BUDS\b/i, 'ACCESORIO'],
];

function derivarMarcaCategoria({ nombre, tipo, marca, categoria }) {
  const texto = String(nombre ?? '').toUpperCase();

  let marcaFinal = marca;
  if (!marcaFinal) {
    for (const [patron, valor] of REGLAS_MARCA) {
      if (patron.test(texto)) { marcaFinal = valor; break; }
    }
  }
  // Ultimo recurso: nombres viejos sin ninguna palabra de marca, solo
  // "14 PRO MAX ..." — "PRO MAX" no lo usa ninguna otra marca, es una señal
  // razonablemente segura de que es un iPhone (ej. el mismo caso que TRAI
  // reporto: "14 PRO MAX MEP 100 128 CHIP").
  if (!marcaFinal && /\b1[1-7]\b/.test(texto) && /\bPRO\b|\bPLUS\b|\bMINI\b|\bMAX\b|\bAIR\b/.test(texto)) {
    marcaFinal = 'APPLE';
  }

  let categoriaFinal = categoria;
  if (!categoriaFinal) {
    if (tipo === 'servicio') categoriaFinal = 'SERVICIO';
    else if (tipo === 'accesorio') categoriaFinal = 'ACCESORIO';
    else {
      categoriaFinal = 'CELULAR';
      for (const [patron, valor] of REGLAS_CATEGORIA_DISPOSITIVO) {
        if (patron.test(texto)) { categoriaFinal = valor; break; }
      }
    }
  }

  return { marca: marcaFinal ?? null, categoria: categoriaFinal ?? null };
}

// "128GB" -> 128, "1TB" -> 1024. Null si no hay unidad explicita — nunca se
// adivina de un numero suelto (podria ser bateria, ciclos u otra cosa).
function extraerAlmacenamientoGb(texto) {
  if (!texto) return null;
  const m = String(texto).match(/\b(\d{1,4})\s?(GB|TB)\b/i);
  if (!m) return null;
  const cantidad = Number(m[1]);
  return m[2].toUpperCase() === 'TB' ? cantidad * 1024 : cantidad;
}

// Espera algo como "Batería 97%" (como lo guarda el importador) o un
// numero simple seguido de "%". Un equipo sellado/nuevo se toma como 100%
// (es lo que significa "sellado" — no es una suposicion, es la definicion).
// Null si no hay ninguna de las dos señales.
function extraerSaludBateria(texto) {
  if (!texto) return null;
  const m = String(texto).match(/\b(\d{1,3})\s?%/);
  if (m) return Number(m[1]);
  if (/\bSELLADO\b|\bNUEVO\b|\bNUEVA\b/i.test(String(texto))) return 100;
  return null;
}

module.exports = { derivarMarcaCategoria, extraerAlmacenamientoGb, extraerSaludBateria };
