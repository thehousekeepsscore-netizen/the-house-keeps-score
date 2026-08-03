import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as clubRecordsController from './clubRecords.controller.js';

// Mounted at /api/clubs/:clubId
export const clubRecordsRouter = Router({ mergeParams: true });
clubRecordsRouter.use(authenticate);

clubRecordsRouter.get('/history', asyncHandler(clubRecordsController.listHistory));
clubRecordsRouter.post('/history/link', asyncHandler(clubRecordsController.linkHistoryPlayer));
clubRecordsRouter.get('/deleted-sessions', asyncHandler(clubRecordsController.listDeletedSessions));
clubRecordsRouter.post('/deleted-sessions/:recordId/restore', asyncHandler(clubRecordsController.restoreSession));

clubRecordsRouter.post('/history/past-session', asyncHandler(clubRecordsController.createPastSession));
clubRecordsRouter.get('/leaderboard', asyncHandler(clubRecordsController.getLeaderboard));
clubRecordsRouter.get('/pot-log', asyncHandler(clubRecordsController.listPotLog));

clubRecordsRouter.post('/pending-changes', asyncHandler(clubRecordsController.requestSessionChange));
clubRecordsRouter.get('/pending-changes', asyncHandler(clubRecordsController.listPendingChanges));
clubRecordsRouter.post(
  '/pending-changes/:requestId/:decision(approve|reject)',
  asyncHandler(clubRecordsController.decidePendingChange)
);

clubRecordsRouter.get('/audit-log', asyncHandler(clubRecordsController.listAuditLog));
