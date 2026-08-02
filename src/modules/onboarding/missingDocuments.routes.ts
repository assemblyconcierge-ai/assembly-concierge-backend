import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../common/config';
import { logger } from '../../common/logger';
import {
  processMissingDocumentsSubmission,
  type MissingDocumentsPayload,
} from './missingDocuments.service';

export const missingDocumentsRouter = Router();

missingDocumentsRouter.post(
  '/webhooks/jotform/contractor-missing-documents',
  async (req: Request, res: Response, next: NextFunction) => {
    const correlationId = req.correlationId ?? uuidv4();
    const log = logger.child({ correlationId, handler: 'contractor-missing-documents-webhook' });
    const expectedToken = config.JOTFORM_CONTRACTOR_ONBOARDING_WEBHOOK_TOKEN;
    const providedToken = req.query['token'] as string | undefined;

    if (!expectedToken && config.NODE_ENV === 'production') {
      res.status(503).json({
        error: 'WEBHOOK_SECURITY_NOT_CONFIGURED',
        message: 'Webhook security is not configured',
      });
      return;
    }
    if (expectedToken && providedToken !== expectedToken) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid or missing webhook token' });
      return;
    }
    if (!expectedToken) {
      log.warn('[MissingDocuments] Webhook token is not set; token check skipped outside production');
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    let payload: MissingDocumentsPayload;
    if (typeof body['rawRequest'] === 'string') {
      try {
        payload = JSON.parse(body['rawRequest']) as MissingDocumentsPayload;
      } catch {
        log.warn({ bodyKeys: Object.keys(body) }, '[MissingDocuments] rawRequest parse failed; using parsed fields');
        payload = body as MissingDocumentsPayload;
      }
    } else {
      payload = body as MissingDocumentsPayload;
    }
    if (!payload.formID && body['formID']) payload.formID = String(body['formID']);
    if (!payload.submissionID && body['submissionID']) payload.submissionID = String(body['submissionID']);

    try {
      const result = await processMissingDocumentsSubmission(payload);
      res.status(result.status === 'retry_pending' ? 503 : 200).json({
        status: result.status,
        contractorId: result.contractorId,
        documentStatus: result.documentStatus,
        processedFiles: result.processedFiles,
        errors: result.errors,
        notificationStatus: result.notificationStatus,
      });
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      const code = (error as { code?: string }).code;
      if (statusCode && statusCode < 500) {
        res.status(statusCode).json({
          error: code ?? 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'Invalid request',
        });
        return;
      }
      log.error({ error }, '[MissingDocuments] Unexpected processing failure');
      next(error);
    }
  },
);
