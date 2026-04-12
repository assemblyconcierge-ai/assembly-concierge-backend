export type JobStatus =
  | 'intake_received'
  | 'intake_validated'
  | 'quoted_outside_area'
  | 'awaiting_payment'
  | 'deposit_paid'
  | 'paid_in_full'
  | 'ready_for_dispatch'
  | 'dispatch_in_progress'
  | 'assigned'
  | 'scheduled'
  | 'work_completed'
  | 'completion_reported'
  | 'awaiting_remainder_payment'
  | 'closed_paid'
  | 'cancelled'
  | 'error_review';

/** Valid transitions: from → Set<to> */
const TRANSITIONS: Record<JobStatus, Set<JobStatus>> = {
  intake_received: new Set(['intake_validated', 'quoted_outside_area', 'error_review', 'cancelled']),
  intake_validated: new Set(['awaiting_payment', 'quoted_outside_area', 'error_review', 'cancelled']),
  quoted_outside_area: new Set(['cancelled']),
  awaiting_payment: new Set(['deposit_paid', 'paid_in_full', 'cancelled', 'error_review']),
  deposit_paid: new Set(['ready_for_dispatch', 'awaiting_remainder_payment', 'cancelled', 'error_review']),
  paid_in_full: new Set(['ready_for_dispatch', 'cancelled', 'error_review']),
  ready_for_dispatch: new Set(['dispatch_in_progress', 'cancelled', 'error_review']),
  dispatch_in_progress: new Set(['assigned', 'ready_for_dispatch', 'cancelled', 'error_review']),
  assigned: new Set(['scheduled', 'completion_reported', 'work_completed', 'cancelled', 'error_review']),
  scheduled: new Set(['work_completed', 'cancelled', 'error_review']),
  work_completed: new Set(['completion_reported', 'awaiting_remainder_payment', 'closed_paid', 'error_review']),
  // completion_reported: contractor said FINISH; awaits operator approval before billing
  completion_reported: new Set(['awaiting_remainder_payment', 'closed_paid', 'error_review']),
  awaiting_remainder_payment: new Set(['closed_paid', 'error_review']),
  closed_paid: new Set([]),
  cancelled: new Set([]),
  error_review: new Set(['intake_received', 'awaiting_payment', 'cancelled']),
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from]?.has(to) ?? false;
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(
      `Invalid job state transition: ${from} → ${to}`,
    );
  }
}

export function getAllowedTransitions(from: JobStatus): JobStatus[] {
  return Array.from(TRANSITIONS[from] ?? []);
}
