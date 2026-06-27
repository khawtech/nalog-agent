// ──────────────────────────────────────────────────────────────────────────
// NaLog platform connector (read-only). Composes paddy state from the live
// NaLog REST API (Firebase Bearer auth), or returns the bundled demo dataset
// when NALOG_USE_DEMO=true / no API configured.
//
// NaLog has no aggregated "paddy status" endpoint, so getPaddyStatus() stitches
// together paddy + AWD cycle + sensors + latest readings, the way the agent
// needs to reason about a field.
// ──────────────────────────────────────────────────────────────────────────
import config from '../config.js';
import logger from '../logger.js';
import {
  DEMO_FARM,
  DEMO_PADDIES,
  DEMO_SENSORS,
  DEMO_AWD_CYCLE,
  demoSensorHistory,
} from './demoData.js';
import { buildCropCalendar } from './cropCalendar.js';

const useDemo = () => config.nalog.useDemo || !config.nalog.apiUrl;

function authHeader(token) {
  const raw = token || config.nalog.authToken || '';
  if (!raw) return {};
  const value = raw.startsWith('Bearer ') ? raw : `Bearer ${raw}`;
  return { Authorization: value };
}

async function apiGet(path, token) {
  const url = `${config.nalog.apiUrl}${path}`;
  const res = await fetch(url, {
    headers: {
      ...authHeader(token),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    throw new Error(`NaLog GET ${path} failed: ${res.status} ${json.error || ''}`);
  }
  return json.data;
}

export async function getFarms(token) {
  if (useDemo()) return [DEMO_FARM];
  return apiGet('/api/farms', token);
}

/** Map farm name or id to canonical farmId (LLMs often pass the display name). */
export async function resolveFarmId(farmIdOrName, token) {
  if (!farmIdOrName) return null;
  const farms = await getFarms(token).catch(() => []);
  const byId = farms.find((f) => f.farmId === farmIdOrName);
  if (byId) return byId.farmId;
  const norm = String(farmIdOrName).trim().toLowerCase();
  const byName = farms.find((f) => f.name.trim().toLowerCase() === norm);
  if (byName) return byName.farmId;
  return farmIdOrName;
}

export async function getPaddies(farmId, token) {
  if (useDemo()) return DEMO_PADDIES.filter((p) => p.farmId === farmId);
  return apiGet(`/api/farms/${farmId}/paddies`, token);
}

export async function getPaddy(paddyId, token) {
  if (useDemo()) return DEMO_PADDIES.find((p) => p.paddyId === paddyId) || null;
  return apiGet(`/api/paddies/${paddyId}`, token);
}

export async function getSensorsForFarm(farmId, token) {
  if (useDemo()) return DEMO_SENSORS.filter((s) => s.farmId === farmId);
  return apiGet(`/api/farms/${farmId}/sensors`, token);
}

export async function getAWDCycle(paddyId, token) {
  if (useDemo()) return paddyId === DEMO_AWD_CYCLE.paddyId ? DEMO_AWD_CYCLE : null;
  try {
    return await apiGet(`/api/paddies/${paddyId}/awd-cycle`, token);
  } catch {
    return null;
  }
}

export async function getSensorHistory(sensorId, hours = 72, token) {
  if (useDemo()) return demoSensorHistory(sensorId, hours);
  const data = await apiGet(`/api/sensors/${sensorId}/data?limit=500`, token);
  const cutoff = Date.now() - hours * 3_600_000;
  return (data || [])
    .filter((d) => new Date(d.timestamp).getTime() >= cutoff)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

export async function getPumpControls(farmId, token) {
  if (useDemo()) return [];
  return apiGet(`/api/farms/${farmId}/pump-controls`, token);
}

export async function getIrrigationEvents(farmId, token, { paddyId, limit = 50 } = {}) {
  if (useDemo()) return [];
  const path = paddyId
    ? `/api/paddies/${paddyId}/irrigation-events?limit=${limit}`
    : `/api/farms/${farmId}/irrigation-events?limit=${limit}`;
  return apiGet(path, token);
}

/** Recent watering / pump activity for a farm or single paddy. */
export async function getIrrigationHistory({ farmId, paddyId, hours = 720 }, token) {
  const cutoff = Date.now() - hours * 3_600_000;
  const [pumps, events] = await Promise.all([
    getPumpControls(farmId, token).catch(() => []),
    getIrrigationEvents(farmId, token, { paddyId, limit: 200 }).catch(() => []),
  ]);
  const inWindow = (ts) => new Date(ts).getTime() >= cutoff;
  const mapPump = (p) => ({
    type: 'pump_control',
    action: p.action,
    paddyId: p.paddyId,
    timestamp: p.timestamp,
    reason: p.reason,
    triggeredBy: p.triggeredBy,
  });
  const mapEvent = (e) => ({
    type: 'irrigation_event',
    eventType: e.eventType,
    paddyId: e.paddyId,
    timestamp: e.timestamp,
    duration: e.duration,
    waterVolume: e.waterVolume,
    triggeredBy: e.triggeredBy,
  });
  const scoped = (items, mapper) =>
    (items || [])
      .filter((item) => !paddyId || item.paddyId === paddyId)
      .map(mapper);
  const allCombined = [...scoped(pumps, mapPump), ...scoped(events, mapEvent)].sort(
    (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
  );
  const inWindowEvents = allCombined.filter((e) => inWindow(e.timestamp));
  const lastWatering =
    allCombined.find((e) => e.action === 'start' || e.eventType === 'pump_start') ||
    allCombined[0] ||
    null;
  const lastWateringByPaddy = {};
  for (const e of allCombined) {
    if (!e.paddyId) continue;
    const prev = lastWateringByPaddy[e.paddyId];
    if (!prev || new Date(e.timestamp) > new Date(prev.timestamp)) {
      lastWateringByPaddy[e.paddyId] = e;
    }
  }
  return {
    farmId,
    paddyId: paddyId || null,
    hours,
    events: inWindowEvents.slice(0, 30),
    count: inWindowEvents.length,
    totalAvailable: allCombined.length,
    lastWatering,
    lastWateringByPaddy,
    oldestInDataset: allCombined.at(-1)?.timestamp || null,
    newestInDataset: allCombined[0]?.timestamp || null,
  };
}

/**
 * Aggregated, agent-friendly view of a paddy's current state.
 */
export async function getPaddyStatus(paddyId, token) {
  const paddy = await getPaddy(paddyId, token);
  if (!paddy) return null;

  const [sensorsAll, awdCycle] = await Promise.all([
    getSensorsForFarm(paddy.farmId, token).catch(() => []),
    paddy.cropType === 'rice' ? getAWDCycle(paddyId, token).catch(() => null) : Promise.resolve(null),
  ]);

  const sensors = (sensorsAll || []).filter((s) => s.paddyId === paddyId);
  const readings = await Promise.all(
    sensors.map(async (s) => {
      const hist = await getSensorHistory(s.sensorId, 72, token).catch(() => []);
      const latest = hist[hist.length - 1] || null;
      const trend = computeTrend(hist);
      return {
        sensorId: s.sensorId,
        type: s.type,
        devEUI: s.devEUI,
        battery: s.battery,
        latest: latest?.payload || null,
        latestAt: latest?.timestamp || null,
        trendPerDay: trend,
        pointCount: hist.length,
      };
    })
  );

  return {
    paddy: {
      paddyId: paddy.paddyId,
      farmId: paddy.farmId,
      name: paddy.name,
      cropType: paddy.cropType,
      growthStage: paddy.growthStage,
      plantingDate: paddy.plantingDate || null,
      expectedHarvestDate: paddy.expectedHarvestDate || null,
      cropStatus: paddy.cropStatus || null,
      area: paddy.area ?? null,
      riceConfig: paddy.riceConfig,
      sugarcaneConfig: paddy.sugarcaneConfig,
    },
    cropCalendar: buildCropCalendar(paddy),
    awdCycle,
    sensors: readings,
    fetchedAt: new Date().toISOString(),
  };
}

function computeTrend(history) {
  if (!history || history.length < 2) return null;
  const valueOf = (d) =>
    d.payload?.level ?? d.payload?.moisture ?? d.payload?.value ?? null;
  const first = history[0];
  const last = history[history.length - 1];
  const v0 = valueOf(first);
  const v1 = valueOf(last);
  if (v0 == null || v1 == null) return null;
  const days =
    (new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime()) / 86_400_000;
  if (days <= 0) return null;
  return +((v1 - v0) / days).toFixed(2);
}

export function nalogMode() {
  return useDemo() ? 'demo' : 'live';
}

logger.info({ mode: useDemo() ? 'demo' : 'live' }, 'NaLog connector initialised');
