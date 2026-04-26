import { describe, it, expect } from 'vitest';
import { parseSchedule } from '../../src/common/utils/scheduleUtils';

const TZ = 'America/New_York';

describe('parseSchedule', () => {
  // ── Valid windows ────────────────────────────────────────────────────────

  it('Morning(8am-12pm) → 08:00–12:00 ET as UTC', () => {
    const { scheduledStartAt, scheduledEndAt } = parseSchedule(
      '2026-05-02',
      'Morning(8am-12pm)',
      TZ,
    );
    // 2026-05-02 is EDT (UTC-4)
    expect(scheduledStartAt.toISOString()).toBe('2026-05-02T12:00:00.000Z');
    expect(scheduledEndAt.toISOString()).toBe('2026-05-02T16:00:00.000Z');
  });

  it('Afternoon(12pm-4pm) → 12:00–16:00 ET as UTC', () => {
    const { scheduledStartAt, scheduledEndAt } = parseSchedule(
      '2026-05-02',
      'Afternoon(12pm-4pm)',
      TZ,
    );
    expect(scheduledStartAt.toISOString()).toBe('2026-05-02T16:00:00.000Z');
    expect(scheduledEndAt.toISOString()).toBe('2026-05-02T20:00:00.000Z');
  });

  it('Evening(4pm-8pm) → 16:00–20:00 ET as UTC', () => {
    const { scheduledStartAt, scheduledEndAt } = parseSchedule(
      '2026-05-02',
      'Evening(4pm-8pm)',
      TZ,
    );
    expect(scheduledStartAt.toISOString()).toBe('2026-05-02T20:00:00.000Z');
    expect(scheduledEndAt.toISOString()).toBe('2026-05-03T00:00:00.000Z');
  });

  // ── Whitespace / case tolerance ──────────────────────────────────────────

  it('whitespace/case variant "  MORNING ( 8am - 12pm ) " resolves correctly', () => {
    const { scheduledStartAt, scheduledEndAt } = parseSchedule(
      '2026-05-02',
      '  MORNING ( 8am - 12pm ) ',
      TZ,
    );
    expect(scheduledStartAt.toISOString()).toBe('2026-05-02T12:00:00.000Z');
    expect(scheduledEndAt.toISOString()).toBe('2026-05-02T16:00:00.000Z');
  });

  // ── Error cases ──────────────────────────────────────────────────────────

  it('bare "Morning" throws SCHEDULE_PARSE_FAILED', () => {
    expect(() => parseSchedule('2026-05-02', 'Morning', TZ)).toThrow(
      'SCHEDULE_PARSE_FAILED: unrecognized window: Morning',
    );
  });

  it('unknown window throws SCHEDULE_PARSE_FAILED', () => {
    expect(() => parseSchedule('2026-05-02', 'Night(8pm-12am)', TZ)).toThrow(
      'SCHEDULE_PARSE_FAILED: unrecognized window: Night(8pm-12am)',
    );
  });

  it('missing date throws SCHEDULE_REQUIRED', () => {
    expect(() => parseSchedule('', 'Morning(8am-12pm)', TZ)).toThrow(
      'SCHEDULE_REQUIRED: appointment_date and appointment_window are required',
    );
  });

  it('missing window throws SCHEDULE_REQUIRED', () => {
    expect(() => parseSchedule('2026-05-02', '', TZ)).toThrow(
      'SCHEDULE_REQUIRED: appointment_date and appointment_window are required',
    );
  });

  it('invalid date throws SCHEDULE_PARSE_FAILED', () => {
    expect(() => parseSchedule('not-a-date', 'Morning(8am-12pm)', TZ)).toThrow(
      'SCHEDULE_PARSE_FAILED: invalid date: not-a-date',
    );
  });
});
