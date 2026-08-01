export class AppError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 500) {
    super(message);
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) { super("not_found", `${what} not found`, 404); }
}
export class ValidationError extends AppError {
  constructor(msg: string) { super("validation", msg, 400); }
}
export class AuthError extends AppError {
  constructor(msg = "unauthorized", code = "unauthorized") { super(code, msg, 401); }
}
export class ForbiddenError extends AppError {
  constructor(msg: string, code = "forbidden") { super(code, msg, 403); }
}
export class ConflictError extends AppError {
  constructor(msg: string, code = "conflict") { super(code, msg, 409); }
}
export class GitError extends AppError {
  constructor(msg: string) { super("git_error", msg, 500); }
}
