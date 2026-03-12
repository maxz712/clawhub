import { Context } from "hono";
import { AppError } from "../services/errors.js";

export function errorHandler(err: Error, c: Context) {
  if (err instanceof AppError) {
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
        },
      },
      err.statusCode as any
    );
  }

  console.error("Unhandled error:", err);
  return c.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
      },
    },
    500
  );
}
