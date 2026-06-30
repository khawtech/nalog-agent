import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEMO_FARM,
  DEMO_FARMER,
  DEMO_PADDIES,
  DEMO_SENSORS,
  DEMO_AWD_CYCLE,
  DEMO_SEED_MEMORIES,
  DEMO_PROFILE_FACTS,
  demoSensorHistory,
} from '../src/integrations/demoData.js';

test('demo farm has required fields', () => {
  assert.ok(DEMO_FARM.farmId);
  assert.ok(DEMO_FARM.name);
  assert.equal(DEMO_FARM.status, 'active');
});

test('demo farmer has required fields', () => {
  assert.ok(DEMO_FARMER.farmerId);
  assert.ok(DEMO_FARMER.name);
  assert.equal(DEMO_FARMER.role, 'farmer');
});

test('demo paddies include rice and sugarcane', () => {
  const types = DEMO_PADDIES.map((p) => p.cropType);
  assert.ok(types.includes('rice'));
  assert.ok(types.includes('sugarcane'));
  for (const p of DEMO_PADDIES) {
    assert.ok(p.paddyId, 'every paddy needs an id');
    assert.ok(p.farmId, 'every paddy needs a farmId');
    assert.ok(p.growthStage, 'every paddy needs a growthStage');
  }
});

test('demo sensors match paddies', () => {
  const paddyIds = new Set(DEMO_PADDIES.map((p) => p.paddyId));
  for (const s of DEMO_SENSORS) {
    assert.ok(paddyIds.has(s.paddyId), `sensor ${s.sensorId} references unknown paddy ${s.paddyId}`);
    assert.ok(s.devEUI, 'sensors need a devEUI');
  }
});

test('AWD cycle references a real paddy', () => {
  const paddyIds = new Set(DEMO_PADDIES.map((p) => p.paddyId));
  assert.ok(paddyIds.has(DEMO_AWD_CYCLE.paddyId));
  assert.ok(DEMO_AWD_CYCLE.active);
});

test('seed memories cover multiple types', () => {
  const types = new Set(DEMO_SEED_MEMORIES.map((m) => m.type));
  assert.ok(types.size >= 3, `expected >=3 memory types, got ${types.size}`);
  for (const m of DEMO_SEED_MEMORIES) {
    assert.ok(m.text.length > 10, 'memory text should be substantive');
  }
});

test('profile facts include language and irrigation style', () => {
  const keys = DEMO_PROFILE_FACTS.map((f) => f.key);
  assert.ok(keys.includes('preferred_language'));
  assert.ok(keys.includes('irrigation_style'));
  for (const f of DEMO_PROFILE_FACTS) {
    assert.ok(f.confidence > 0 && f.confidence <= 1);
  }
});

test('demoSensorHistory returns expected number of points', () => {
  const hist = demoSensorHistory('sensor-awd-p3', 24);
  assert.equal(hist.length, 25);
  for (const d of hist) {
    assert.ok(d.timestamp);
    assert.ok(d.payload);
    assert.ok(typeof d.payload.level === 'number');
  }
});

test('demoSensorHistory soil sensor returns moisture', () => {
  const hist = demoSensorHistory('sensor-soil-c1', 12);
  assert.equal(hist.length, 13);
  assert.ok(typeof hist[0].payload.moisture === 'number');
});

test('demoSensorHistory AWD shows draining trend', () => {
  const hist = demoSensorHistory('sensor-awd-p3', 48);
  const first = hist[0].payload.level;
  const last = hist[hist.length - 1].payload.level;
  assert.ok(first > last, `AWD should drain: first=${first}, last=${last}`);
});
