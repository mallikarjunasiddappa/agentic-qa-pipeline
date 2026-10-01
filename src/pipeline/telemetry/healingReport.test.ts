import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHealingReport, isoWeekKey } from './healingReport';
import type { HealingEvent } from '../types/schemas';

function event(overrides: Partial<HealingEvent>): HealingEvent {
  return {
    timestamp: '2026-08-05T00:00:00Z', // a Wednesday - week 2026-W32
    testFilePath: 'tests/auth/x.spec.ts',
    suite: 'auth',
    attemptNumber: 1,
    outcome: 'healed',
    category: 'locator_drift',
    ...overrides,
  };
}

test('isoWeekKey is stable within a calendar week and changes across weeks', () => {
  // Wed 2026-08-05 and Fri 2026-08-07 are the same ISO week.
  assert.equal(isoWeekKey(new Date('2026-08-05T00:00:00Z')), isoWeekKey(new Date('2026-08-07T00:00:00Z')));
  // A week later must differ.
  assert.notEqual(isoWeekKey(new Date('2026-08-05T00:00:00Z')), isoWeekKey(new Date('2026-08-12T00:00:00Z')));
});

test('buildHealingReport computes overall healing rate as healed / (healed + escalated)', () => {
  const events = [
    event({ outcome: 'healed' }),
    event({ outcome: 'healed' }),
    event({ outcome: 'escalated', category: 'real_regression' }),
    event({ outcome: 'passed_no_heal_needed', category: undefined, attemptNumber: 0 }),
  ];
  const report = buildHealingReport(events, new Date('2026-08-05T12:00:00Z'));

  assert.equal(report.totalEvents, 4);
  assert.equal(report.overall.healed, 2);
  assert.equal(report.overall.escalated, 1);
  assert.equal(report.overall.passedNoHealNeeded, 1);
  assert.equal(report.overall.healingRate, 2 / 3);
});

test('buildHealingReport reports null healing rate when there is nothing to divide', () => {
  const events = [event({ outcome: 'passed_no_heal_needed', category: undefined, attemptNumber: 0 })];
  const report = buildHealingReport(events, new Date('2026-08-05T12:00:00Z'));
  assert.equal(report.overall.healingRate, null);
});

test('buildHealingReport computes average attempts-to-heal from healed events only', () => {
  const events = [
    event({ outcome: 'healed', attemptNumber: 1 }),
    event({ outcome: 'healed', attemptNumber: 3 }),
    event({ outcome: 'escalated', category: 'real_regression', attemptNumber: 3 }),
  ];
  const report = buildHealingReport(events, new Date('2026-08-05T12:00:00Z'));
  assert.equal(report.overall.avgAttemptsToHeal, 2);
});

test('buildHealingReport groups by week and suite independently', () => {
  const events = [
    event({ suite: 'auth', outcome: 'healed' }),
    event({ suite: 'student', outcome: 'escalated', category: 'ui_restructure' }),
    event({ suite: 'auth', timestamp: '2026-08-12T00:00:00Z', outcome: 'healed' }), // next week
  ];
  const report = buildHealingReport(events, new Date('2026-08-05T12:00:00Z'));

  assert.equal(report.byWeekAndSuite.length, 3);
  const week1Auth = report.byWeekAndSuite.find((s) => s.suite === 'auth' && s.week === isoWeekKey(new Date('2026-08-05T00:00:00Z')));
  assert.ok(week1Auth);
  assert.equal(week1Auth!.healed, 1);
});

test('buildHealingReport computes category breakdown percentages over categorized events only', () => {
  const events = [
    event({ outcome: 'healed', category: 'locator_drift' }),
    event({ outcome: 'healed', category: 'locator_drift' }),
    event({ outcome: 'escalated', category: 'real_regression' }),
    event({ outcome: 'passed_no_heal_needed', category: undefined, attemptNumber: 0 }),
  ];
  const report = buildHealingReport(events, new Date('2026-08-05T12:00:00Z'));
  const stats = report.byWeekAndSuite[0];

  // 2 of 3 categorized events are locator_drift, 1 of 3 is real_regression - passed event excluded.
  assert.ok(Math.abs(stats.categoryBreakdownPct.locator_drift - (2 / 3) * 100) < 0.001);
  assert.ok(Math.abs(stats.categoryBreakdownPct.real_regression - (1 / 3) * 100) < 0.001);
  assert.equal(stats.categoryBreakdownPct.copy_change, 0);
});

test('buildHealingReport computes week-over-week trend per suite', () => {
  const now = new Date('2026-08-12T12:00:00Z'); // this week
  const events = [
    // last week (2026-08-05): 1 healed, 1 escalated -> 50%
    event({ suite: 'auth', timestamp: '2026-08-05T00:00:00Z', outcome: 'healed' }),
    event({
      suite: 'auth',
      timestamp: '2026-08-06T00:00:00Z',
      outcome: 'escalated',
      category: 'real_regression',
    }),
    // this week (2026-08-12): 2 healed, 0 escalated -> 100%
    event({ suite: 'auth', timestamp: '2026-08-12T00:00:00Z', outcome: 'healed' }),
    event({ suite: 'auth', timestamp: '2026-08-13T00:00:00Z', outcome: 'healed' }),
  ];
  const report = buildHealingReport(events, now);
  const trend = report.trendBySuite.find((t) => t.suite === 'auth')!;

  assert.equal(trend.previousWeekHealingRate, 0.5);
  assert.equal(trend.currentWeekHealingRate, 1);
  assert.ok(Math.abs(trend.deltaPct! - 50) < 0.001);
});

test('buildHealingReport reports null trend when a week has no data', () => {
  const now = new Date('2026-08-12T12:00:00Z');
  const events = [event({ suite: 'auth', timestamp: '2026-08-12T00:00:00Z', outcome: 'healed' })];
  const report = buildHealingReport(events, now);
  const trend = report.trendBySuite.find((t) => t.suite === 'auth')!;

  assert.equal(trend.previousWeekHealingRate, null);
  assert.equal(trend.deltaPct, null);
});
