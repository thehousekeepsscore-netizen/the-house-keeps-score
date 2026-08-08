import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as offlineSessionsController from './offlineSessions.controller.js';

// Mounted at /api/clubs/:clubId/offline-sessions
export const offlineSessionsRouter = Router({ mergeParams: true });
offlineSessionsRouter.use(authenticate);

offlineSessionsRouter.get('/active', asyncHandler(offlineSessionsController.getActive));
offlineSessionsRouter.post('/', asyncHandler(offlineSessionsController.startSession));
offlineSessionsRouter.post('/:sessionId/join', asyncHandler(offlineSessionsController.joinSession));
offlineSessionsRouter.post('/:sessionId/start-playing', asyncHandler(offlineSessionsController.startPlaying));
offlineSessionsRouter.post('/:sessionId/extend', asyncHandler(offlineSessionsController.extendSession));
offlineSessionsRouter.post('/:sessionId/cash-out-requests/amend', asyncHandler(offlineSessionsController.amendCashOut));
offlineSessionsRouter.post('/:sessionId/remove-from-lobby', asyncHandler(offlineSessionsController.removeFromLobby));
offlineSessionsRouter.post('/:sessionId/begin-settling', asyncHandler(offlineSessionsController.beginSettling));
offlineSessionsRouter.post('/:sessionId/resume', asyncHandler(offlineSessionsController.resumeNight));
offlineSessionsRouter.post('/:sessionId/lift-time-limit', asyncHandler(offlineSessionsController.liftTimeLimit));
offlineSessionsRouter.post('/:sessionId/sit-in-requests', asyncHandler(offlineSessionsController.requestSitIn));
offlineSessionsRouter.post(
  '/:sessionId/sit-in-requests/:decision(approve|reject)',
  asyncHandler(offlineSessionsController.decideSitIn)
);
offlineSessionsRouter.post('/:sessionId/cash-out-requests', asyncHandler(offlineSessionsController.requestCashOut));
offlineSessionsRouter.post(
  '/:sessionId/cash-out-requests/:decision(approve|reject)',
  asyncHandler(offlineSessionsController.decideCashOut)
);
offlineSessionsRouter.post('/:sessionId/buy-in-requests', asyncHandler(offlineSessionsController.requestBuyIn));
offlineSessionsRouter.get('/:sessionId/buy-in-requests', asyncHandler(offlineSessionsController.listBuyInRequests));
offlineSessionsRouter.post(
  '/:sessionId/buy-in-requests/:requestId/:decision(approve|reject)',
  asyncHandler(offlineSessionsController.decideBuyInRequest)
);
// Tells a night what it is playing for, once. POST rather than PATCH because
// it creates something that did not exist and cannot be repeated — a PATCH
// implies an edit, and an edit is exactly what this refuses to be.
offlineSessionsRouter.post(
  '/:sessionId/settlement-rules',
  asyncHandler(offlineSessionsController.initSettlementRules)
);

offlineSessionsRouter.post('/:sessionId/settle', asyncHandler(offlineSessionsController.settleSession));
