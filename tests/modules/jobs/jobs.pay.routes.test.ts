import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryOne } from '../../../src/db/pool';
import { jobsRouter } from '../../../src/modules/jobs/jobs.routes';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/jobs', jobsRouter);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'TEST_ERROR', message: err.message });
  });
  return app;
}

const payPageJob = {
  id: 'job-123',
  job_key: 'AC-2099-TEST',
  customer_id: 'customer-123',
  service_type_id: 'service-123',
  status: 'awaiting_payment',
  rush_requested: false,
  appointment_date: new Date('2099-06-15T00:00:00.000Z'),
  appointment_window: 'Morning(8am-12pm)',
  total_amount_cents: 10900,
  deposit_amount_cents: 2500,
  remainder_amount_cents: 8400,
  payment_mode: 'deposit',
};

describe('GET /jobs/pay/:token', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (sql.includes('public_pay_token')) return payPageJob as any;
      if (sql.includes('SELECT full_name FROM customers')) return { full_name: 'Jane Smith' } as any;
      if (sql.includes('SELECT display_name, code FROM service_types')) {
        return { display_name: 'Small Assembly', code: 'small' } as any;
      }
      if (sql.includes('SELECT checkout_url FROM payments')) return null;
      return null;
    });
  });

  it('returns a safe public payment summary when checkout is not ready yet', async () => {
    const app = createTestApp();

    const res = await request(app)
      .get('/jobs/pay/ppt_test')
      .expect(200);

    expect(res.body).toEqual({
      jobKey: 'AC-2099-TEST',
      status: 'awaiting_payment',
      customerName: 'Jane Smith',
      serviceType: 'Small Assembly',
      rushRequested: false,
      appointmentDate: payPageJob.appointment_date.toISOString(),
      appointmentWindow: 'Morning(8am-12pm)',
      totalAmountCents: 10900,
      depositAmountCents: 2500,
      remainderAmountCents: 8400,
      paymentMode: 'deposit',
      checkoutUrl: null,
    });
  });
});
