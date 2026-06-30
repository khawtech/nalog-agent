import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCropCalendar } from '../src/integrations/cropCalendar.js';

test('returns null for missing paddy', () => {
  assert.equal(buildCropCalendar(null), null);
  assert.equal(buildCropCalendar({}), null);
  assert.equal(buildCropCalendar({ cropType: 'rice' }), null);
});

test('rice calendar has expected fields', () => {
  const cal = buildCropCalendar({
    cropType: 'rice',
    growthStage: 'vegetative',
    plantingDate: '2026-05-20',
  });
  assert.ok(cal);
  assert.equal(cal.currentStage, 'vegetative');
  assert.equal(cal.stageDurationDays, 21);
  assert.equal(typeof cal.daysSincePlanting, 'number');
  assert.ok(cal.daysSincePlanting >= 0);
});

test('rice calendar without planting date still works', () => {
  const cal = buildCropCalendar({
    cropType: 'rice',
    growthStage: 'flowering',
  });
  assert.ok(cal);
  assert.equal(cal.currentStage, 'flowering');
  assert.equal(cal.daysSincePlanting, null);
});

test('sugarcane sugar_formation recommends stopping irrigation', () => {
  const cal = buildCropCalendar({
    cropType: 'sugarcane',
    growthStage: 'sugar_formation',
    plantingDate: '2025-11-01',
  });
  assert.ok(cal);
  assert.equal(cal.shouldStopIrrigation, true);
  assert.match(cal.recommendation, /stop irrigation/i);
});

test('sugarcane grand_growth with irrigationStopped false continues irrigation', () => {
  const cal = buildCropCalendar({
    cropType: 'sugarcane',
    growthStage: 'grand_growth',
    plantingDate: '2026-02-10',
    sugarcaneConfig: { irrigationStopped: false },
  });
  assert.ok(cal);
  assert.equal(cal.shouldStopIrrigation, false);
  assert.equal(cal.irrigationStopped, false);
});
