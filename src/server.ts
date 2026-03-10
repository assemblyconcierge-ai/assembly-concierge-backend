import 'dotenv/config';
import { createApp } from './app';
import { config } from './common/config';
import { logger } from './common/logger';
import { closePool } from './db/pool';

const app = createApp();
const PORT = config.PORT;

const server = app.listen(PORT, () => {
  logger.info(`[AC-API] Assembly Concierge API v2.0.0 running on port ${PORT}`);
  logger.info(`[AC-API] Environment: ${config.NODE_ENV}`);
  logger.info(`[AC-API] Health: http://localhost:${PORT}/health`);
});

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  logger.info(`[AC-API] ${signal} received — shutting down gracefully`);
  server.close(async () => {
    await closePool();
    logger.info('[AC-API] Server closed');
    process.exit(0);
  });
  // Force exit after 10s
  setTimeout(() => process.exit(1), 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.error({ err }, '[AC-API] Uncaught exception');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, '[AC-API] Unhandled rejection');
  process.exit(1);
});
