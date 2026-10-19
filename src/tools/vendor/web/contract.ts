// Adapter-only constants/types; request.ts is copied from pi-codex-web-run (see LICENSE).
export const WEB_SEARCH_MAX_OUTPUT_TOKENS = 2_500;
export type WebRunOutput = Record<string, unknown> & { output_text?: string; search_results?: unknown[] };
