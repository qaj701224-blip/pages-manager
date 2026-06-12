declare module '@xd/pages-runtime-protocol' {
  export const RUNTIME: {
    BASE_PATH: string;
    KV_GET_PATH: string;
    KV_PUT_PATH: string;
    KV_DELETE_PATH: string;
  };
  export const GATEWAY: {
    KV_GET_PATH: string;
    KV_PUT_PATH: string;
    KV_DELETE_PATH: string;
  };
  export const HEADERS: {
    RUNTIME_REQUEST: string;
  };
  export const ERROR_CODES: Record<string, string>;
  export function buildOkEnvelope(payload?: Record<string, unknown>): Record<string, unknown>;
  export function buildErrorEnvelope(code: string, message: string): Record<string, unknown>;
  export function validateUserKey(key: unknown):
    | { ok: true; value: string }
    | { ok: false; error: { code: string; message: string } };
  export function validateKvType(type?: unknown):
    | { ok: true; value: 'json' | 'text' }
    | { ok: false; error: { code: string; message: string } };
  export function validateTtl(expirationTtl?: unknown):
    | { ok: true; value: number | undefined }
    | { ok: false; error: { code: string; message: string } };
}
