import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({ error: "Validation failed", details: err.flatten() });
  }

  // Body-parser failures are the client's mistake, not ours. Without this they
  // fell through to the 500 below, which meant a truncated upload or a typo in
  // a curl command was recorded as a server fault -- noise in the logs that
  // looks exactly like a real outage, and a status code that tells the caller
  // to retry something that will never succeed.
  const parseError = err as { type?: string; status?: number };
  if (parseError?.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body is too large" });
  }
  if (err instanceof SyntaxError && parseError.status === 400 && "body" in (err as object)) {
    return res.status(400).json({ error: "Request body is not valid JSON" });
  }

  console.error(err);
  return res.status(500).json({ error: "Internal server error" });
}
