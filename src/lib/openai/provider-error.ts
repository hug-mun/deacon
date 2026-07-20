export type OpenAiFailureKind =
  | "quota_exhausted"
  | "rate_limited"
  | "authentication"
  | "permission_denied"
  | "provider_unavailable"
  | "network"
  | "invalid_request";

export type OpenAiProviderFailure = {
  kind: OpenAiFailureKind;
  status: number | null;
  code: string | null;
  requestId: string | null;
  retryAfterSeconds: number | null;
};

type ErrorBody = {
  error?: {
    code?: string;
    type?: string;
    message?: string;
  };
};

export function classifyOpenAiFailure(
  status: number | null,
  body: unknown,
  headers?: Headers,
): OpenAiProviderFailure {
  const error = (body as ErrorBody | null)?.error;
  const code = error?.code ?? error?.type ?? null;
  const message = error?.message?.toLowerCase() ?? "";
  const requestId = headers?.get("x-request-id") ?? null;
  const retryAfterHeader = headers?.get("retry-after");
  const retryAfterSeconds = retryAfterHeader && /^\d+$/.test(retryAfterHeader)
    ? Number(retryAfterHeader)
    : null;

  if (
    code === "insufficient_quota" ||
    message.includes("exceeded your current quota") ||
    message.includes("run out of credits") ||
    message.includes("billing details") ||
    message.includes("maximum monthly spend")
  ) {
    return { kind: "quota_exhausted", status, code, requestId, retryAfterSeconds };
  }

  if (status === 429 || code === "rate_limit_exceeded") {
    return { kind: "rate_limited", status, code, requestId, retryAfterSeconds };
  }

  if (
    status === 403 ||
    code === "missing_scope" ||
    code === "insufficient_permissions" ||
    message.includes("missing scope") ||
    message.includes("insufficient permissions") ||
    message.includes("model.request")
  ) {
    return { kind: "permission_denied", status, code, requestId, retryAfterSeconds };
  }

  if (status === 401 || code === "invalid_api_key" || code === "invalid_api_key_provided") {
    return { kind: "authentication", status, code, requestId, retryAfterSeconds };
  }

  if (status !== null && status >= 500) {
    return { kind: "provider_unavailable", status, code, requestId, retryAfterSeconds };
  }

  return { kind: "invalid_request", status, code, requestId, retryAfterSeconds };
}

export function networkFailure(error: unknown): OpenAiProviderFailure {
  return {
    kind: "network",
    status: null,
    code: error instanceof Error ? error.name : null,
    requestId: null,
    retryAfterSeconds: null,
  };
}

export function openAiSearchNotice(failure: OpenAiProviderFailure) {
  switch (failure.kind) {
    case "quota_exhausted":
      return {
        code: "ai_credits_unavailable",
        message: "La búsqueda por significado no está disponible porque se agotó el crédito de IA. Puedes seguir buscando por palabras.",
      };
    case "rate_limited":
      return {
        code: "ai_rate_limited",
        message: "La búsqueda por significado está ocupada. Mostramos resultados por palabras; inténtalo de nuevo más tarde.",
      };
    case "authentication":
      return {
        code: "ai_configuration_error",
        message: "La búsqueda por significado necesita revisar la configuración de IA. Puedes seguir buscando por palabras.",
      };
    case "permission_denied":
      return {
        code: "ai_permission_denied",
        message: "La clave de IA no tiene permiso para usar el modelo. Puedes seguir buscando por palabras.",
      };
    case "network":
    case "provider_unavailable":
      return {
        code: "ai_temporarily_unavailable",
        message: "La búsqueda por significado no responde ahora. Mostramos resultados por palabras.",
      };
    default:
      return {
        code: "ai_request_failed",
        message: "La búsqueda por significado no pudo completarse. Mostramos resultados por palabras.",
      };
  }
}
