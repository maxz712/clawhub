import type { ErrorHandler } from "hono";
import { AppError } from "../services/errors.js";

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: err.code, message: err.message }, err.status as 400 | 401 | 403 | 404 | 409 | 500);
  }
  console.error("[unhandled]", err);
  return c.json({ error: "internal_error", message: "internal server error" }, 500);
};
