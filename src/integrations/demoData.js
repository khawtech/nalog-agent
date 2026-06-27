// ──────────────────────────────────────────────────────────────────────────
// Demo dataset modelled on a real KhawTECH deployment in Kut Chum, Yasothon.
// Used when NALOG_USE_DEMO=true (offline demo) and to seed memory. Shapes match
// the live NaLog API so the connector is a drop-in swap.
// ──────────────────────────────────────────────────────────────────────────

export const DEMO_FARMER = {
  farmerId: 'farmer-somchai',
  email: 'somchai@kutchum.example',
  name: 'Somchai',
  role: 'farmer',
};

export const DEMO_FARM = {
  farmId: 'farm-kutchum',
  businessId: 'biz-khawtech',
  name: 'Kut Chum Family Farm',
  status: 'active',
  description: '32 rai family rice & sugarcane farm, Kut Chum, Yasothon',
  location: { lat: 16.2719, lng: 104.3853 },
};

export const DEMO_PADDIES = [
  {
    paddyId: 'paddy-rice-3',
    farmId: 'farm-kutchum',
    name: 'Paddy 3 (North Rice)',
    cropType: 'rice',
    cropStatus: 'growing',
    growthStage: 'vegetative',
    area: 4,
    plantingDate: '2026-05-20',
    riceConfig: {
      awdEnabled: true,
      awdCycleId: 'awd-paddy3',
      targetWaterDepth: 5,
      drainageDepth: 15,
      pumpControlEnabled: true,
      pumpDevEUI: 'a84041000181bcd1',
    },
  },
  {
    paddyId: 'paddy-cane-1',
    farmId: 'farm-kutchum',
    name: 'Paddy 1 (Sugarcane West)',
    cropType: 'sugarcane',
    cropStatus: 'growing',
    growthStage: 'grand_growth',
    area: 6,
    plantingDate: '2026-02-10',
    sugarcaneConfig: {
      irrigationServiceType: 'managed',
      irrigationScheduleId: 'sched-cane1',
      varietyType: 'Khon Kaen 3',
      irrigationStopped: false,
    },
  },
];

export const DEMO_SENSORS = [
  {
    sensorId: 'sensor-awd-p3',
    farmId: 'farm-kutchum',
    paddyId: 'paddy-rice-3',
    name: 'AWD Tube — Paddy 3',
    type: 'awd',
    devEUI: 'a84041000181aa01',
    active: true,
    battery: 87,
    location: { lat: 16.272, lng: 104.3855 },
  },
  {
    sensorId: 'sensor-soil-c1',
    farmId: 'farm-kutchum',
    paddyId: 'paddy-cane-1',
    name: 'Soil Moisture — Cane 1',
    type: 'soil_moisture',
    devEUI: 'a84041000181aa02',
    active: true,
    battery: 72,
    location: { lat: 16.2715, lng: 104.385 },
  },
];

export const DEMO_AWD_CYCLE = {
  cycleId: 'awd-paddy3',
  paddyId: 'paddy-rice-3',
  farmId: 'farm-kutchum',
  currentPhase: 'draining',
  cycleNumber: 3,
  minWaterLevel: -15,
  maxWaterLevel: 5,
  active: true,
  autoControlEnabled: true,
};

// Generate ~hours of AWD water-level readings showing a realistic drain trend.
export function demoSensorHistory(sensorId, hours = 72) {
  const sensor = DEMO_SENSORS.find((s) => s.sensorId === sensorId);
  const now = Date.now();
  const points = Math.min(hours, 168);
  const out = [];
  if (sensor?.type === 'awd') {
    // Draining from +5cm toward -15cm over the window (AWD dry-down).
    for (let i = points; i >= 0; i--) {
      const t = now - i * 3_600_000;
      const progress = (points - i) / points;
      const level = +(5 - progress * 17 + (Math.random() - 0.5) * 0.6).toFixed(1);
      out.push({
        dataId: `${sensorId}-${t}`,
        sensorId,
        timestamp: new Date(t).toISOString(),
        payload: { level, unit: 'cm', battery: sensor.battery },
      });
    }
  } else {
    for (let i = points; i >= 0; i--) {
      const t = now - i * 3_600_000;
      const moisture = +(42 + Math.sin(i / 6) * 6 + (Math.random() - 0.5) * 2).toFixed(1);
      out.push({
        dataId: `${sensorId}-${t}`,
        sensorId,
        timestamp: new Date(t).toISOString(),
        payload: { moisture, unit: '%' },
      });
    }
  }
  return out;
}

// Seed memories representing experience accumulated over prior seasons.
export const DEMO_SEED_MEMORIES = [
  {
    paddyId: 'paddy-rice-3',
    type: 'outcome',
    text: 'Last wet season AWD on Paddy 3 cut pumping by ~31% with no yield loss; farmer was satisfied.',
    structured: { waterSavingPct: 31, yieldImpact: 'none' },
  },
  {
    paddyId: 'paddy-rice-3',
    type: 'observation',
    text: 'Paddy 3 drains from +5cm to -15cm in about 4 days in dry spells; faster after the field was re-levelled.',
    structured: { dryDownDays: 4 },
  },
  {
    paddyId: 'paddy-rice-3',
    type: 'preference',
    text: 'Farmer prefers to approve pump-on himself rather than full auto, especially near flowering.',
    structured: { autoControl: false },
  },
  {
    paddyId: 'paddy-cane-1',
    type: 'decision',
    text: 'Stopped irrigation on Cane 1 during sugar formation last year; sugar content rose ~1.5%.',
    structured: { sugarGainPct: 1.5 },
  },
];

export const DEMO_PROFILE_FACTS = [
  { key: 'preferred_language', value: 'th', confidence: 0.95 },
  { key: 'channel', value: 'webchat', confidence: 0.9 },
  { key: 'irrigation_style', value: 'manual_approval', confidence: 0.85 },
  { key: 'crops', value: ['rice', 'sugarcane'], confidence: 0.95 },
  { key: 'location', value: 'Kut Chum, Yasothon', confidence: 0.99 },
];
