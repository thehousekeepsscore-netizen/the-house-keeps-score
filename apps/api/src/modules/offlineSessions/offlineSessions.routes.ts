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
offlineSessionsRouter.post('/:sessionId/settle', asyncHandler(offlineSessionsController.settleSession));
