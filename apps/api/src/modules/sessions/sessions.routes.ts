import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as sessionsController from './sessions.controller.js';

// Mounted at /api/clubs/:clubId/sessions
export const clubSessionsRouter = Router({ mergeParams: true });
clubSessionsRouter.use(authenticate);
clubSessionsRouter.get('/virtual-table', asyncHandler(sessionsController.getActiveVirtualTable));
clubSessionsRouter.post('/virtual-table', asyncHandler(sessionsController.createVirtualTable));

// Mounted at /api/sessions/:sessionId
export const sessionsRouter = Router();
sessionsRouter.use(authenticate);
sessionsRouter.get('/:sessionId', asyncHandler(sessionsController.getOne));
sessionsRouter.post('/:sessionId/enter', asyncHandler(sessionsController.enter));
sessionsRouter.post('/:sessionId/bots', asyncHandler(sessionsController.addBot));
sessionsRouter.post('/:sessionId/deal', asyncHandler(sessionsController.dealHand));
sessionsRouter.post('/:sessionId/fold', asyncHandler(sessionsController.fold));
sessionsRouter.post('/:sessionId/check', asyncHandler(sessionsController.check));
sessionsRouter.post('/:sessionId/call', asyncHandler(sessionsController.call));
sessionsRouter.post('/:sessionId/raise', asyncHandler(sessionsController.betRaise));
sessionsRouter.patch('/:sessionId/settings', asyncHandler(sessionsController.updateSettings));
sessionsRouter.post('/:sessionId/end', asyncHandler(sessionsController.endSession));
sessionsRouter.get('/:sessionId/hand-history', asyncHandler(sessionsController.listHandHistory));
sessionsRouter.get('/:sessionId/buy-in-requests', asyncHandler(sessionsController.listBuyInRequests));
sessionsRouter.post('/:sessionId/buy-in-requests', asyncHandler(sessionsController.requestBuyIn));
sessionsRouter.post('/:sessionId/buy-in-requests/:requestId/:decision(approve|reject)', asyncHandler(sessionsController.decideBuyInRequest));
