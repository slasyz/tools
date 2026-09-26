export const SANDBOX_AUTHORIZATION_EVENT = "pi-sandbox:authorize";

export type SandboxFileAccess = {
  readonly kind: "read" | "write";
  readonly path: string;
};

export type SandboxAuthorizationRequest = {
  readonly source: string;
  readonly cwd: string;
  readonly accesses: readonly SandboxFileAccess[];
};

export type SandboxAuthorizationEvent = SandboxAuthorizationRequest & {
  // Register during event dispatch; authorization may finish asynchronously.
  readonly waitUntil: (authorize: () => void | Promise<void>) => void;
};

export type SandboxAuthorizationEvents = {
  emit(channel: string, data: unknown): void;
};

function isSandboxFileAccess(value: unknown): value is SandboxFileAccess {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    (value.kind === "read" || value.kind === "write") &&
    "path" in value &&
    typeof value.path === "string"
  );
}

export function isSandboxAuthorizationEvent(value: unknown): value is SandboxAuthorizationEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "source" in value &&
    typeof value.source === "string" &&
    "cwd" in value &&
    typeof value.cwd === "string" &&
    "accesses" in value &&
    Array.isArray(value.accesses) &&
    value.accesses.every(isSandboxFileAccess) &&
    "waitUntil" in value &&
    typeof value.waitUntil === "function"
  );
}

export async function requestSandboxAuthorization(
  events: SandboxAuthorizationEvents,
  request: SandboxAuthorizationRequest,
): Promise<void> {
  const authorizers: (() => void | Promise<void>)[] = [];
  let dispatching = true;
  const event: SandboxAuthorizationEvent = Object.freeze({
    source: request.source,
    cwd: request.cwd,
    accesses: Object.freeze(request.accesses.map((access) => Object.freeze({ ...access }))),
    waitUntil(authorize: () => void | Promise<void>) {
      if (!dispatching) {
        throw new Error("Sandbox authorizers must register during event dispatch");
      }
      authorizers.push(authorize);
    },
  });

  try {
    events.emit(SANDBOX_AUTHORIZATION_EVENT, event);
  } finally {
    dispatching = false;
  }
  if (authorizers.length === 0) {
    throw new Error("pi-sandbox is missing or inactive; operation blocked");
  }

  // Capture synchronous throws and wait for every policy decision before returning.
  const results = await Promise.allSettled(
    authorizers.map((authorize) => Promise.resolve().then(authorize)),
  );
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
}
