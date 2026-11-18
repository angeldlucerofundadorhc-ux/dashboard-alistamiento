// Vercel Serverless Function: Sincronización Automática con Lucy API v1
// Madero Automotores - Centro de Alistamiento & Taller (/api/v1/unidad/stock/)
// Seguridad Operativa: Los campos financieros (costo, venta, margen, moneda) se omiten rigurosamente.

const FALLBACK_DATA = require('../data/snapshot.json');

const LUCY_BASE_URL = process.env.LUCY_BASE_URL || 'https://maderoautomotores.lucy.ar';
const LUCY_USER = process.env.LUCY_USER;
const LUCY_PASSWORD = process.env.LUCY_PASSWORD;

const ALLOWED_ORIGINS = [
  'https://dashboard-alistamiento-pi.vercel.app',
  'https://dashboard-alistamiento-skynetjohnconnor1-2660s-projects.vercel.app',
  'http://localhost:3000'
];

// Control de cuota diaria en memoria para la instancia serverless
let dailyCallCount = 0;
let lastResetDate = new Date().toISOString().slice(0, 10);
let cacheSnapshot = null;
let lastFetchTime = null;
let lastForceAttemptTime = 0;

const TTL_CACHE_MS = 30 * 60 * 1000; // 30 minutos de caché en memoria
const MIN_FORCE_INTERVAL_MS = 60 * 1000; // Cooldown mínimo de 60s para ?force=true

const TALLER_KEYWORDS = ['mecanico', 'chapista', 'galpon', 'movimiento', 'mohe', 'b&m', 'bilova', 'taller'];

function sanitizeOperationalData(rawItems) {
  let list = rawItems;
  if (rawItems && rawItems.data && Array.isArray(rawItems.data.unidades)) {
    list = rawItems.data.unidades;
  } else if (rawItems && Array.isArray(rawItems.unidades)) {
    list = rawItems.unidades;
  } else if (rawItems && Array.isArray(rawItems.results)) {
    list = rawItems.results;
  }

  if (!Array.isArray(list)) {
    return FALLBACK_DATA.stock_items;
  }

  return list.map((item, idx) => {
    const ubicacion = item.lugar || item.ubicacion || item.location || 'Sin asignar / Salón no especificado';
    const locLower = ubicacion.toLowerCase();
    const isTaller = Boolean(
      item.is_taller ||
      TALLER_KEYWORDS.some(kw => locLower.includes(kw))
    );

    // Cálculo dinámico de días de permanencia
    let dias = 0;
    if (item.fecha_ingreso) {
      const entryTime = new Date(item.fecha_ingreso.replace(' ', 'T')).getTime();
      if (!isNaN(entryTime)) {
        dias = Math.max(0, Math.floor((Date.now() - entryTime) / (1000 * 60 * 60 * 24)));
      }
    } else if (item.dias !== undefined && !isNaN(Number(item.dias))) {
      dias = Number(item.dias);
    }

    // Categorización de aging (semáforo)
    let aging_cat = '0-30 días';
    let aging_status = 'Fresco';
    let aging_badge = 'green';
    if (dias > 365) {
      aging_cat = '+365 días';
      aging_status = 'Inmovilizado';
      aging_badge = 'red';
    } else if (dias > 180) {
      aging_cat = '181-365 días';
      aging_status = 'Crítico';
      aging_badge = 'orange';
    } else if (dias > 90) {
      aging_cat = '91-180 días';
      aging_status = 'Alerta';
      aging_badge = 'yellow';
    } else if (dias > 30) {
      aging_cat = '31-90 días';
      aging_status = 'Normal';
      aging_badge = 'blue';
    }

    const reservada = Boolean(
      item.reservada ||
      item.seniada === true ||
      item.fecha_reserva ||
      (item.reservo_usuario && Number(item.reservo_usuario) > 0)
    );

    const consignada = Boolean(
      item.consignada ||
      (typeof item.consignante === 'string' && item.consignante.trim().length > 0)
    );

    const fotosList = Array.isArray(item.imagenes) ? item.imagenes : (Array.isArray(item.fotos) ? item.fotos : []);
    const tieneFoto = Boolean(item.tiene_foto || fotosList.length > 0);
    const cantidadFotos = fotosList.length > 0 ? fotosList.length : (Number(item.cantidad_fotos) || 0);

    return {
      id: item.id_unidades || item.id || idx + 1,
      marca: (item.marca || '').toString().trim(),
      modelo: (item.modelo || '').toString().trim(),
      version: (item.version || '').toString().trim(),
      trans: item.transmision || item.trans || 'MT',
      combust: item.combustible || item.combust || 'NAFTA',
      kms: Number(item.kilometraje) || Number(item.kms) || 0,
      anio: Number(item.anio) || 0,
      tipo: item.tipo || item.body_type || 'VEHICULO',
      dominio: (item.dominio || item.license_plate || '0KM').toString().trim().toUpperCase(),
      color: (item.color || 'No especificado').toString().trim(),
      ubicacion: ubicacion,
      is_taller: isTaller,
      dias: dias,
      aging_cat: aging_cat,
      aging_status: aging_status,
      aging_badge: aging_badge,
      reservada: reservada,
      consignada: consignada,
      tiene_foto: tieneFoto,
      cantidad_fotos: cantidadFotos
    };
  });
}

function buildOperationalPayload(cleanItems, now = Date.now()) {
  const total = cleanItems.length;
  const reservadas = cleanItems.filter(i => i.reservada);
  const enTaller = cleanItems.filter(i => i.is_taller);
  const disponibles = cleanItems.filter(i => !i.reservada && !i.is_taller);
  const conFoto = cleanItems.filter(i => i.tiene_foto);
  const sinFoto = cleanItems.filter(i => !i.tiene_foto);

  const diasStockTotal = cleanItems.reduce((acc, i) => acc + (i.dias || 0), 0);
  const diasTallerTotal = enTaller.reduce((acc, i) => acc + (i.dias || 0), 0);

  const operational_summary = {
    total_unidades: total,
    disponibles: disponibles.length,
    disponibles_pct: total > 0 ? Number(((disponibles.length / total) * 100).toFixed(1)) : 0,
    en_taller: enTaller.length,
    en_taller_pct: total > 0 ? Number(((enTaller.length / total) * 100).toFixed(1)) : 0,
    reservadas: reservadas.length,
    reservadas_pct: total > 0 ? Number(((reservadas.length / total) * 100).toFixed(1)) : 0,
    con_foto: conFoto.length,
    con_foto_pct: total > 0 ? Number(((conFoto.length / total) * 100).toFixed(1)) : 0,
    sin_foto: sinFoto.length,
    sin_foto_pct: total > 0 ? Number(((sinFoto.length / total) * 100).toFixed(1)) : 0,
    dias_stock_promedio: total > 0 ? Number((diasStockTotal / total).toFixed(1)) : 0,
    dias_taller_promedio: enTaller.length > 0 ? Number((diasTallerTotal / enTaller.length).toFixed(1)) : 0
  };

  const locMap = {};
  cleanItems.forEach(i => {
    const loc = i.ubicacion || 'Sin asignar';
    if (!locMap[loc]) {
      locMap[loc] = {
        nombre: loc,
        is_taller: i.is_taller,
        unidades: 0,
        total_dias: 0,
        con_foto: 0,
        sin_foto: 0,
        reservadas: 0
      };
    }
    locMap[loc].unidades++;
    locMap[loc].total_dias += (i.dias || 0);
    if (i.tiene_foto) locMap[loc].con_foto++;
    else locMap[loc].sin_foto++;
    if (i.reservada) locMap[loc].reservadas++;
  });

  const locations = Object.values(locMap).map(l => ({
    nombre: l.nombre,
    is_taller: l.is_taller,
    unidades: l.unidades,
    dias_promedio: l.unidades > 0 ? Number((l.total_dias / l.unidades).toFixed(1)) : 0,
    con_foto: l.con_foto,
    sin_foto: l.sin_foto,
    reservadas: l.reservadas
  })).sort((a, b) => b.unidades - a.unidades);

  const workshops = locations.filter(l => l.is_taller);

  return {
    meta: {
      titulo: 'Madero Automotores · Centro de Alistamiento & Taller',
      subtitulo: 'Monitoreo Operativo en Vivo desde Lucy DMS',
      version: '1.2.0',
      synced_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
      total_unidades: total
    },
    operational_summary: operational_summary,
    stock_items: cleanItems,
    locations: locations,
    workshops: workshops,
    pre_delivery: reservadas
  };
}

module.exports = async function handler(req, res) {
  const headers = req.headers || {};
  const origin = headers.origin;

  // Cabeceras de seguridad en respuestas API
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  // CORS restringido a orígenes permitidos
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Madero-Client');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Método no permitido' });
  }

  const currentDate = new Date().toISOString().slice(0, 10);
  if (currentDate !== lastResetDate) {
    dailyCallCount = 0;
    lastResetDate = currentDate;
  }

  const forceSync = req.query?.force === 'true';
  const now = Date.now();

  // Protección contra abuso de cuota en ?force=true
  if (forceSync) {
    const isVercelCron = String(headers['user-agent'] || '').toLowerCase().includes('vercel-cron');
    const isAllowedForceClient =
      headers['sec-fetch-site'] === 'same-origin' ||
      headers['x-madero-client'] === 'alistamiento-ui' ||
      isVercelCron ||
      ALLOWED_ORIGINS.includes(origin);

    const hasFallbackOrCache = Boolean(cacheSnapshot || FALLBACK_DATA);
    const inCooldown = !isVercelCron && (now - lastForceAttemptTime) < MIN_FORCE_INTERVAL_MS;

    if (!isAllowedForceClient || (inCooldown && hasFallbackOrCache)) {
      return res.status(200).json({
        ok: true,
        source: 'rate_limited_cache',
        message: 'Solicitud force=true limitada por protección de cuota. Se sirve caché operacional.',
        quota: {
          used: dailyCallCount,
          max_safety_cutoff: 28,
          daily_limit: 32,
          remaining: Math.max(0, 32 - dailyCallCount)
        },
        data: cacheSnapshot || FALLBACK_DATA
      });
    }
  }

  // Verificar si la caché en memoria sigue vigente
  if (!forceSync && cacheSnapshot && lastFetchTime && (now - lastFetchTime < TTL_CACHE_MS)) {
    return res.status(200).json({
      ok: true,
      source: 'cache_vigente',
      cached_at: new Date(lastFetchTime).toISOString(),
      ttl_minutes_remaining: Math.round((TTL_CACHE_MS - (now - lastFetchTime)) / 60000),
      quota: {
        used: dailyCallCount,
        max_safety_cutoff: 28,
        daily_limit: 32,
        remaining: Math.max(0, 32 - dailyCallCount)
      },
      data: cacheSnapshot
    });
  }

  // Si no hay credenciales configuradas
  if (!LUCY_USER || !LUCY_PASSWORD) {
    return res.status(200).json({
      ok: true,
      source: 'snapshot_local',
      message: 'Operando con snapshot operacional (166 unidades sanitizadas). Para activar sincronización en vivo con Lucy, configure LUCY_USER y LUCY_PASSWORD en Vercel Dashboard.',
      connected: false,
      quota: {
        used: 0,
        max_safety_cutoff: 28,
        daily_limit: 32,
        remaining: 32
      },
      data: FALLBACK_DATA
    });
  }

  // Verificar corte preventivo de llamadas
  if (dailyCallCount >= 28) {
    return res.status(200).json({
      ok: true,
      source: 'cuota_alcanzada',
      message: 'Se alcanzó el corte preventivo diario a Lucy DMS para proteger el límite de 32 reqs/día. Se sirve caché operacional.',
      quota: {
        used: dailyCallCount,
        max_safety_cutoff: 28,
        daily_limit: 32,
        remaining: Math.max(0, 32 - dailyCallCount)
      },
      data: cacheSnapshot || FALLBACK_DATA
    });
  }

  if (forceSync) {
    lastForceAttemptTime = now;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    dailyCallCount++;
    const authHeader = 'Basic ' + Buffer.from(`${LUCY_USER}:${LUCY_PASSWORD}`).toString('base64');
    const endpointUrl = `${LUCY_BASE_URL.replace(/\/+$/, '')}/api/v1/unidad/stock/`;

    const lucyResponse = await fetch(endpointUrl, {
      method: 'GET',
      headers: {
        'Authorization': authHeader,
        'Accept': 'application/json',
        'User-Agent': 'Madero-Alistamiento-Sync/1.2'
      },
      signal: controller.signal
    });

    if (lucyResponse.status === 401 || lucyResponse.status === 403) {
      return res.status(200).json({
        ok: false,
        source: 'error_auth',
        message: 'Lucy rechazó el usuario o contraseña configurada. Se sirve snapshot operacional.',
        data: cacheSnapshot || FALLBACK_DATA
      });
    }

    if (lucyResponse.status === 429) {
      return res.status(200).json({
        ok: false,
        source: 'lucy_429',
        message: 'Lucy respondió HTTP 429 (Límite diario alcanzado). Se sirve snapshot de resguardo.',
        data: cacheSnapshot || FALLBACK_DATA
      });
    }

    if (!lucyResponse.ok) {
      return res.status(200).json({
        ok: false,
        source: 'error_lucy_http',
        message: `Lucy respondió con HTTP ${lucyResponse.status}. Se sirve snapshot de resguardo.`,
        data: cacheSnapshot || FALLBACK_DATA
      });
    }

    const rawData = await lucyResponse.json();
    const cleanItems = sanitizeOperationalData(rawData);
    const sanitizedPayload = buildOperationalPayload(cleanItems, now);

    // Ajustar conteo con la telemetría real de Lucy si la provee
    if (rawData.data && typeof rawData.data.cantidad_en_fecha === 'number') {
      dailyCallCount = rawData.data.cantidad_en_fecha;
    }

    cacheSnapshot = sanitizedPayload;
    lastFetchTime = now;

    return res.status(200).json({
      ok: true,
      source: 'lucy_live',
      message: 'Sincronización exitosa con la API v1 de Lucy DMS.',
      synced_at: new Date(now).toISOString(),
      quota: {
        used: dailyCallCount,
        max_safety_cutoff: 28,
        daily_limit: rawData.data?.maxima_cantidad_por_dia || 32,
        remaining: Math.max(0, (rawData.data?.maxima_cantidad_por_dia || 32) - dailyCallCount)
      },
      data: sanitizedPayload
    });

  } catch (error) {
    console.error('Lucy sync error:', error);
    return res.status(200).json({
      ok: false,
      source: 'error_conexion',
      message: 'Error de conexión con el servidor operativo. Se sirve snapshot de resguardo.',
      data: cacheSnapshot || FALLBACK_DATA
    });
  } finally {
    clearTimeout(timeout);
  }
};
