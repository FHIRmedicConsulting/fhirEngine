/**
 * Helpers for constructing FHIR-conformant `OperationOutcome` error responses
 * and the corresponding HTTP status codes.
 *
 * Status mapping per `docs/reference/api-reference.md`.
 */

import type { OperationOutcome, OperationOutcomeIssue } from "@ronin/fhir-types";

export class FhirError extends Error {
  readonly status: number;
  readonly outcome: OperationOutcome;

  constructor(status: number, issues: OperationOutcomeIssue[]) {
    super(issues.map((i) => i.diagnostics ?? i.code).join("; "));
    this.status = status;
    this.outcome = {
      resourceType: "OperationOutcome",
      issue: issues,
    };
  }
}

export function badRequest(message: string, expression?: string[]): FhirError {
  return new FhirError(400, [
    {
      severity: "error",
      code: "invalid",
      diagnostics: message,
      expression,
    },
  ]);
}

export function unauthorized(message = "Authentication required"): FhirError {
  return new FhirError(401, [
    { severity: "error", code: "login", diagnostics: message },
  ]);
}

export function forbidden(message = "Access forbidden"): FhirError {
  return new FhirError(403, [
    { severity: "error", code: "forbidden", diagnostics: message },
  ]);
}

export function notFound(resourceType: string, id: string): FhirError {
  return new FhirError(404, [
    {
      severity: "error",
      code: "not-found",
      diagnostics: `${resourceType}/${id} not found`,
    },
  ]);
}

export function conflict(message: string): FhirError {
  return new FhirError(409, [
    { severity: "error", code: "conflict", diagnostics: message },
  ]);
}

export function preconditionFailed(message: string): FhirError {
  return new FhirError(412, [
    { severity: "error", code: "conflict", diagnostics: message },
  ]);
}

export function unprocessable(message: string, expression?: string[]): FhirError {
  return new FhirError(422, [
    {
      severity: "error",
      code: "processing",
      diagnostics: message,
      expression,
    },
  ]);
}

export function tooManyRequests(message: string, retryAfter?: number): FhirError {
  const err = new FhirError(429, [
    { severity: "error", code: "throttled", diagnostics: message },
  ]);
  // retryAfter intentionally surfaced via headers in the router, not the body
  (err as FhirError & { retryAfter?: number }).retryAfter = retryAfter;
  return err;
}

export function internalServerError(message = "Internal server error"): FhirError {
  return new FhirError(500, [
    { severity: "fatal", code: "exception", diagnostics: message },
  ]);
}

export function gone(resourceType: string, id: string): FhirError {
  return new FhirError(410, [
    {
      severity: "error",
      code: "deleted",
      diagnostics: `${resourceType}/${id} has been deleted`,
    },
  ]);
}
