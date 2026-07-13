import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPool } from '../../src/db/pool';

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    NODE_ENV: 'production',
    ENABLE_TEST_ROUTES: 'true',
    STRIPE_SECRET_KEY: 'sk_test_security_guard',
    ADMIN_JWT_SECRET: 'test-admin-secret',
  },
}));

vi.mock('../../src/common/config', () => ({ config: mockConfig }));

import { schemaResetRouter } from '../../src/modules/admin/schemaReset.routes';
import { testJobsRouter } from '../../src/modules/admin/testJobs.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin', schemaResetRouter);
  app.use('/admin', testJobsRouter);
  return app;
}

beforeEach(() => {
  mockConfig.NODE_ENV = 'production';
  mockConfig.ENABLE_TEST_ROUTES = 'true';
  vi.clearAllMocks();
  process.env.RESET_SCHEMA_TOKEN = 'configured-reset-token';
});

describe('production-only admin route guards', () => {
  it('returns 404 for POST /admin/reset-schema before accessing the database', async () => {
    const res = await request(buildApp())
      .post('/admin/reset-schema')
      .set('X-Reset-Token', 'configured-reset-token');

    expect(res.status).toBe(404);
    expect(getPool).not.toHaveBeenCalled();
  });

  it('returns 404 for POST /admin/test-jobs even when test routes are enabled', async () => {
    const res = await request(buildApp())
      .post('/admin/test-jobs')
      .set('X-Admin-Token', 'test-admin-secret')
      .send({});

    expect(res.status).toBe(404);
  });

  it('returns 404 for GET /admin/jobs/:jobId/payment-events even when test routes are enabled', async () => {
    const res = await request(buildApp())
      .get('/admin/jobs/aaaaaaaa-0000-0000-0000-000000000001/payment-events')
      .set('X-Admin-Token', 'test-admin-secret');

    expect(res.status).toBe(404);
  });
});
