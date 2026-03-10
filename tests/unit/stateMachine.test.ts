import { describe, it, expect } from 'vitest';
import {
  canTransition,
  assertTransition,
  getAllowedTransitions,
} from '../../src/modules/jobs/job.stateMachine';

describe('Job state machine', () => {
  it('allows intake_received → intake_validated', () => {
    expect(canTransition('intake_received', 'intake_validated')).toBe(true);
  });

  it('allows intake_received → quoted_outside_area', () => {
    expect(canTransition('intake_received', 'quoted_outside_area')).toBe(true);
  });

  it('allows intake_validated → awaiting_payment', () => {
    expect(canTransition('intake_validated', 'awaiting_payment')).toBe(true);
  });

  it('allows awaiting_payment → deposit_paid', () => {
    expect(canTransition('awaiting_payment', 'deposit_paid')).toBe(true);
  });

  it('allows awaiting_payment → paid_in_full', () => {
    expect(canTransition('awaiting_payment', 'paid_in_full')).toBe(true);
  });

  it('allows deposit_paid → ready_for_dispatch', () => {
    expect(canTransition('deposit_paid', 'ready_for_dispatch')).toBe(true);
  });

  it('allows work_completed → closed_paid', () => {
    expect(canTransition('work_completed', 'closed_paid')).toBe(true);
  });

  it('allows work_completed → awaiting_remainder_payment', () => {
    expect(canTransition('work_completed', 'awaiting_remainder_payment')).toBe(true);
  });

  it('blocks closed_paid → any transition', () => {
    expect(canTransition('closed_paid', 'awaiting_payment')).toBe(false);
    expect(canTransition('closed_paid', 'cancelled')).toBe(false);
  });

  it('blocks invalid backward transitions', () => {
    expect(canTransition('paid_in_full', 'intake_received')).toBe(false);
    expect(canTransition('assigned', 'awaiting_payment')).toBe(false);
  });

  it('assertTransition throws on invalid transition', () => {
    expect(() => assertTransition('closed_paid', 'awaiting_payment')).toThrow(
      'Invalid job state transition',
    );
  });

  it('assertTransition does not throw on valid transition', () => {
    expect(() => assertTransition('intake_received', 'intake_validated')).not.toThrow();
  });

  it('getAllowedTransitions returns correct set for awaiting_payment', () => {
    const allowed = getAllowedTransitions('awaiting_payment');
    expect(allowed).toContain('deposit_paid');
    expect(allowed).toContain('paid_in_full');
    expect(allowed).toContain('cancelled');
    expect(allowed).not.toContain('closed_paid');
  });
});
