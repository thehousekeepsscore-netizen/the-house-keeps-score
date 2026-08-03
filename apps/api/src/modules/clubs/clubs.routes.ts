import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as clubsController from "./clubs.controller.js";

export const clubsRouter = Router();

clubsRouter.use(authenticate);

clubsRouter.get("/", asyncHandler(clubsController.list));
clubsRouter.post("/", asyncHandler(clubsController.create));
clubsRouter.get("/join-requests", asyncHandler(clubsController.listJoinRequests));
clubsRouter.get("/:clubId", asyncHandler(clubsController.getOne));
clubsRouter.patch("/:clubId", asyncHandler(clubsController.update));
clubsRouter.delete("/:clubId", asyncHandler(clubsController.remove));
clubsRouter.post("/:clubId/superuser-join", asyncHandler(clubsController.superuserJoin));
clubsRouter.post("/:clubId/join-requests", asyncHandler(clubsController.requestToJoin));
clubsRouter.post("/:clubId/join-requests/:requestId/:decision(accept|reject)", asyncHandler(clubsController.decideJoinRequest));
clubsRouter.post("/:clubId/admins", asyncHandler(clubsController.promoteAdmin));
clubsRouter.delete("/:clubId/admins/:userId", asyncHandler(clubsController.demoteAdmin));
clubsRouter.delete("/:clubId/members/:userId", asyncHandler(clubsController.removeMember));
