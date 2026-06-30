// These tests run in demo mode (NALOG_USE_DEMO=true set via npm test script).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nalogMode,
  getFarms,
  getPaddies,
  getPaddy,
  getSensorsForFarm,
  getAWDCycle,
  getSensorHistory,
  getPaddyStatus,
} from '../src/integrations/nalog.js';

test('nalogMode returns demo in test environment', () => {
  assert.equal(nalogMode(), 'demo');
});

test('getFarms returns demo farm', async () => {
  const farms = await getFarms();
  assert.ok(farms.length >= 1);
  assert.ok(farms[0].farmId);
});

test('getPaddies returns demo paddies', async () => {
  const paddies = await getPaddies('farm-kutchum');
  assert.ok(paddies.length >= 2);
});

test('getPaddy returns a single paddy', async () => {
  const paddy = await getPaddy('paddy-rice-3');
  assert.ok(paddy);
  assert.equal(paddy.cropType, 'rice');
  assert.equal(paddy.growthStage, 'vegetative');
});

test('getPaddy returns null for unknown id', async () => {
  const paddy = await getPaddy('nonexistent');
  assert.equal(paddy, null);
});

test('getSensorsForFarm returns sensors', async () => {
  const sensors = await getSensorsForFarm('farm-kutchum');
  assert.ok(sensors.length >= 2);
});

test('getAWDCycle returns cycle for rice paddy', async () => {
  const cycle = await getAWDCycle('paddy-rice-3');
  assert.ok(cycle);
  assert.equal(cycle.paddyId, 'paddy-rice-3');
  assert.ok(cycle.active);
});

test('getAWDCycle returns null for sugarcane', async () => {
  const cycle = await getAWDCycle('paddy-cane-1');
  assert.equal(cycle, null);
});

test('getSensorHistory returns time-sorted points', async () => {
  const hist = await getSensorHistory('sensor-awd-p3', 24);
  assert.ok(hist.length > 0);
  for (let i = 1; i < hist.length; i++) {
    assert.ok(
      new Date(hist[i].timestamp) >= new Date(hist[i - 1].timestamp),
      'history should be chronological'
    );
  }
});

test('getPaddyStatus returns aggregated view', async () => {
  const status = await getPaddyStatus('paddy-rice-3');
  assert.ok(status);
  assert.equal(status.paddy.paddyId, 'paddy-rice-3');
  assert.ok(status.sensors.length >= 1);
  assert.ok(status.cropCalendar);
  assert.ok(status.awdCycle);
  assert.ok(status.fetchedAt);
  const sensor = status.sensors[0];
  assert.ok(sensor.latest, 'should have latest reading');
  assert.ok(typeof sensor.trendPerDay === 'number', 'should compute trend');
});
