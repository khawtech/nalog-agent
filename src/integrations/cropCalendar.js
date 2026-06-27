/**
 * Growth-stage calendar — mirrors the NaLog dashboard (SugarcaneStatus / shared/utils).
 */

const SUGARCANE_STAGES = [
  'land_preparation',
  'planting',
  'germination',
  'tillering',
  'grand_growth',
  'sugar_formation',
  'maturation',
  'harvest',
];

const SUGARCANE_DURATIONS = {
  land_preparation: 14,
  planting: 7,
  germination: 30,
  tillering: 60,
  grand_growth: 180,
  sugar_formation: 60,
  maturation: 30,
  harvest: 14,
};

const RICE_DURATIONS = {
  land_preparation: 14,
  transplanting: 7,
  vegetative: 21,
  tillering: 28,
  panicle_initiation: 14,
  flowering: 14,
  grain_filling: 30,
  maturation: 14,
  harvest: 7,
};

function daysBetween(fromIso, toMs = Date.now()) {
  if (!fromIso) return null;
  return Math.floor((toMs - new Date(fromIso).getTime()) / 86_400_000);
}

function addDays(iso, days) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function nextStage(cropType, currentStage) {
  const stages = cropType === 'sugarcane' ? SUGARCANE_STAGES : null;
  if (!stages) return null;
  const i = stages.indexOf(currentStage);
  return i >= 0 && i < stages.length - 1 ? stages[i + 1] : null;
}

function stageDuration(cropType, stage) {
  if (cropType === 'sugarcane') return SUGARCANE_DURATIONS[stage] ?? 60;
  if (cropType === 'rice') return RICE_DURATIONS[stage] ?? 30;
  return 30;
}

/** Days from planting until the start of `targetStage` (cumulative prior stages). */
function daysUntilStageStart(cropType, targetStage) {
  if (cropType !== 'sugarcane') return null;
  const idx = SUGARCANE_STAGES.indexOf(targetStage);
  if (idx <= 0) return 0;
  let total = 0;
  for (let i = 0; i < idx; i++) total += SUGARCANE_DURATIONS[SUGARCANE_STAGES[i]];
  return total;
}

/** True when plantingDate likely marks crop start, not the start of the current late stage. */
function plantingAlignsWithCumulativeCalendar(cropType, growthStage, daysSincePlanting) {
  if (cropType !== 'sugarcane' || daysSincePlanting == null) return false;
  const daysToCurrent = daysUntilStageStart(cropType, growthStage);
  if (daysToCurrent == null) return false;
  return daysSincePlanting >= daysToCurrent - 7;
}

/**
 * Build agent-friendly crop calendar for a paddy (matches dashboard "Day X of Y").
 */
export function buildCropCalendar(paddy) {
  if (!paddy?.cropType || !paddy?.growthStage) return null;

  const { cropType, growthStage, plantingDate, expectedHarvestDate, sugarcaneConfig } = paddy;
  const daysSincePlanting = daysBetween(plantingDate);
  const stageDays = stageDuration(cropType, growthStage);
  const next = nextStage(cropType, growthStage);

  // Same simplification as SugarcaneStatus.vue: day counter capped at stage duration
  const daysInCurrentStage =
    daysSincePlanting != null ? Math.min(daysSincePlanting, stageDays) : null;
  const daysRemainingInStage =
    daysInCurrentStage != null ? Math.max(0, stageDays - daysInCurrentStage) : null;

  const calendar = {
    plantingDate: plantingDate || null,
    expectedHarvestDate: expectedHarvestDate || null,
    daysSincePlanting,
    currentStage: growthStage,
    stageDurationDays: stageDays,
    daysInCurrentStage,
    daysRemainingInStage,
    nextStage: next,
    irrigationStopped: sugarcaneConfig?.irrigationStopped === true,
  };

  if (daysRemainingInStage != null && plantingDate) {
    calendar.estimatedCurrentStageEndDate = addDays(new Date().toISOString(), daysRemainingInStage);
  }

  if (cropType === 'sugarcane') {
    calendar.shouldStopIrrigation =
      ['sugar_formation', 'maturation'].includes(growthStage) ||
      sugarcaneConfig?.irrigationStopped === true;

    if (growthStage === 'grand_growth' && daysRemainingInStage != null) {
      calendar.daysUntilSugarFormation = daysRemainingInStage;
      calendar.estimatedSugarFormationDate = calendar.estimatedCurrentStageEndDate;
      calendar.recommendation =
        daysRemainingInStage <= 14
          ? 'Approaching sugar formation — plan to stop irrigation within 2 weeks.'
          : `Still in grand growth — continue irrigation; re-evaluate sugar formation in ~${daysRemainingInStage} days.`;
    } else if (growthStage === 'sugar_formation' || growthStage === 'maturation') {
      calendar.recommendation = 'Stop irrigation now — sugar formation/maturation phase.';
    }

    if (
      plantingDate &&
      plantingAlignsWithCumulativeCalendar(cropType, growthStage, daysSincePlanting)
    ) {
      const daysToSugar = daysUntilStageStart('sugarcane', 'sugar_formation');
      calendar.estimatedSugarFormationFromPlanting = addDays(plantingDate, daysToSugar);
      calendar.daysUntilSugarFormationFromPlanting = Math.max(0, daysToSugar - daysSincePlanting);
    }
  }

  if (cropType === 'rice' && next) {
    calendar.nextStageRequiresFlooding = ['panicle_initiation', 'flowering'].includes(next);
  }

  return calendar;
}
