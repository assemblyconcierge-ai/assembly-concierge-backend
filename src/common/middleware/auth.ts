import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

/**
 * Simple admin auth middleware for MVP.
 * Accepts either:
 *   - Bearer token matching ADMIN_JWT_SECRET (for quick integration)
 *   - X-Admin-Token header matching ADMIN_JWT_SECRET
 *
 * Structured for future RBAC upgrade — replace this with a proper JWT validator.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const adminTokenHeader = req.headers['x-admin-token'] as string | undefined;

  const token =
    (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null) ||
    adminTokenHeader ||
    null;

  if (!token) {
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'Admin authentication required' });
    return;
  }

  if (token.trim() !== config.ADMIN_JWT_SECRET.trim()) {
    res.status(403).json({ error: 'FORBIDDEN', message: 'Invalid admin token' });
    return;
  }

  next();
}
