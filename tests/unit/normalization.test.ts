import { describe, it, expect } from 'vitest';
import { normalizeJotformPayload } from '../../src/modules/intake/jotform.normalizer';
import {
  normalizeServiceTypeCode,
  normalizeRushFlag,
} from '../../src/modules/intake/intake.types';
import { normalizePhone, computeIdempotencyKey } from '../../src/common/utils';

describe('Jotform normalization', () => {
  const samplePayload = {
    submissionID: 'SUB-001',
    submissionDate: '2024-03-01T10:00:00Z',
    'q3_name[first]': 'Jane',
    'q3_name[last]': 'Smith',
    q4_email: 'jane@example.com',
    q5_phone: '(404) 555-1234',
    'q6_address[addr_line1]': '123 Main St',
    q7_city: 'Hampton',
    q7_state: 'GA',
    q8_serviceType: 'Small Assembly',
    q9_rush: 'No',
    q10_date: '2024-03-15',
    q11_window: '9am-12pm',
  };

  it('maps all canonical fields correctly', () => {
    const result = normalizeJotformPayload(samplePayload);
    expect(result.externalSubmissionId).toBe('SUB-001');
    expect(result.customer.firstName).toBe('Jane');
    expect(result.customer.lastName).toBe('Smith');
    expect(result.customer.fullName).toBe('Jane Smith');
    expect(result.customer.email).toBe('jane@example.com');
    expect(result.customer.phone).toBe('+14045551234');
    expect(result.address.city).toBe('Hampton');
    expect(result.address.state).toBe('GA');
    expect(result.service.typeCode).toBe('small');
    expect(result.service.rushRequested).toBe(false);
    expect(result.appointment.date).toBe('2024-03-15');
    expect(result.appointment.window).toBe('9am-12pm');
    expect(result.source.raw).toEqual(samplePayload);
  });

  it('handles rush = yes correctly', () => {
    const result = normalizeJotformPayload({ ...samplePayload, q9_rush: 'Yes' });
    expect(result.service.rushRequested).toBe(true);
  });

  it('handles missing optional fields gracefully', () => {
    const minimal = {
      submissionID: 'SUB-002',
      'q3_name[first]': 'Bob',
      'q3_name[last]': 'Jones',
      q4_email: 'bob@example.com',
      q5_phone: '4045550000',
      q7_city: 'McDonough',
      q8_serviceType: 'Medium',
    };
    const result = normalizeJotformPayload(minimal);
    expect(result.customer.firstName).toBe('Bob');
    expect(result.service.typeCode).toBe('medium');
    expect(result.service.rushRequested).toBe(false);
    expect(result.appointment.date).toBeUndefined();
  });

  it('extracts media URLs from photo fields', () => {
    const withPhoto = {
      ...samplePayload,
      q13_photo: 'https://files.jotform.com/photo1.jpg',
    };
    const result = normalizeJotformPayload(withPhoto);
    expect(result.media).toContain('https://files.jotform.com/photo1.jpg');
  });
});

describe('Appointment date normalization', () => {
  // Uses the live DEFAULT_JOTFORM_FIELD_MAPPING which maps appointmentDate → 'q9_preferredDate'

  it('normalises Jotform date object { day, month, year } to ISO YYYY-MM-DD', () => {
    const result = normalizeJotformPayload({
      q9_preferredDate: { day: '02', month: '05', year: '2026' },
      q11_preferredTime: 'Afternoon(12pm-4pm)',
    });
    expect(result.appointment.date).toBe('2026-05-02');
    expect(result.appointment.window).toBe('Afternoon(12pm-4pm)');
  });

  it('passes through an already-ISO date unchanged', () => {
    const result = normalizeJotformPayload({
      q9_preferredDate: '2026-05-02',
      q11_preferredTime: 'Morning(8am-12pm)',
    });
    expect(result.appointment.date).toBe('2026-05-02');
  });

  it('normalises joined YYYY MM DD string to ISO', () => {
    const result = normalizeJotformPayload({
      q9_preferredDate: '2026 05 02',
      q11_preferredTime: 'Evening(4pm-8pm)',
    });
    expect(result.appointment.date).toBe('2026-05-02');
  });

  it('normalises joined MM DD YYYY string to ISO', () => {
    const result = normalizeJotformPayload({
      q9_preferredDate: '05 02 2026',
      q11_preferredTime: 'Morning(8am-12pm)',
    });
    expect(result.appointment.date).toBe('2026-05-02');
  });

  it('returns undefined when appointmentDate is absent', () => {
    const result = normalizeJotformPayload({});
    expect(result.appointment.date).toBeUndefined();
  });
});

describe('Service type normalization', () => {
  it.each([
    ['Small Assembly', 'small'],
    ['MEDIUM', 'medium'],
    ['Large Item Assembly', 'large'],
    ['Treadmill Setup', 'treadmill'],
    ['Custom Job', 'custom'],
    ['custom', 'custom'],
  ])('normalizes "%s" → "%s"', (input, expected) => {
    expect(normalizeServiceTypeCode(input)).toBe(expected);
  });
});

describe('Rush flag normalization', () => {
  it.each([
    ['Yes', true],
    ['yes', true],
    ['true', true],
    ['1', true],
    ['rush', true],
    ['No', false],
    ['no', false],
    ['false', false],
    [undefined, false],
    [true, true],
    [false, false],
  ])('normalizes %s → %s', (input, expected) => {
    expect(normalizeRushFlag(input as any)).toBe(expected);
  });
});

describe('Phone normalization', () => {
  it.each([
    ['(404) 555-1234', '+14045551234'],
    ['404-555-1234', '+14045551234'],
    ['4045551234', '+14045551234'],
    ['14045551234', '+14045551234'],
  ])('normalizes %s → %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });
});

describe('Idempotency key', () => {
  it('produces consistent keys', () => {
    expect(computeIdempotencyKey('jotform', 'SUB-001')).toBe('jotform:SUB-001');
  });
});
