import { DateTime } from 'luxon';

interface ScheduleResult {
  scheduledStartAt: Date;
  scheduledEndAt: Date;
}

const WINDOW_MAP: Record<string, { startHour: number; endHour: number }> = {
  morning: { startHour: 8, endHour: 12 },
  afternoon: { startHour: 12, endHour: 16 },
  evening: { startHour: 16, endHour: 20 },
};

const WINDOW_ALIASES: Record<string, keyof typeof WINDOW_MAP> = {
  'morning(8am-12pm)': 'morning',
  'afternoon(12pm-4pm)': 'afternoon',
  'evening(4pm-8pm)': 'evening',
};

function resolveWindowKey(raw: string): keyof typeof WINDOW_MAP | null {
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, '');
  return WINDOW_ALIASES[normalized] ?? null;
}

export function parseSchedule(
  appointmentDate: string,
  appointmentWindow: string,
  timezone = 'America/New_York',
): ScheduleResult {
  if (!appointmentDate || !appointmentWindow) {
    throw new Error('SCHEDULE_REQUIRED: appointment_date and appointment_window are required');
  }

  const key = resolveWindowKey(appointmentWindow);
  if (key === null) {
    throw new Error(`SCHEDULE_PARSE_FAILED: unrecognized window: ${appointmentWindow}`);
  }

  const { startHour, endHour } = WINDOW_MAP[key];

  const start = DateTime.fromISO(appointmentDate, { zone: timezone }).set({
    hour: startHour,
    minute: 0,
    second: 0,
    millisecond: 0,
  });

  if (!start.isValid) {
    throw new Error(`SCHEDULE_PARSE_FAILED: invalid date: ${appointmentDate}`);
  }

  const end = start.set({ hour: endHour });

  return {
    scheduledStartAt: start.toUTC().toJSDate(),
    scheduledEndAt: end.toUTC().toJSDate(),
  };
}
