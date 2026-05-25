/**
 * Shared types and param helpers for the semantic operation modules
 * (extracted from router.ts — ADR-202).
 */

/** Type alias for operation parameters passed through the semantic router */
export type Params = Record<string, unknown>;

/** Search result item from vault search */
export interface SearchResultItem {
  path: string;
  title?: string;
  score?: number;
  type?: string;
  context?: string;
}

/** Helper to safely extract a string from params */
export function paramStr(params: Params, key: string): string | undefined {
  const val = params[key];
  return typeof val === 'string' ? val : undefined;
}

/** Helper to safely extract a number from params */
export function paramNum(params: Params, key: string): number | undefined {
  const val = params[key];
  return typeof val === 'number' ? val : undefined;
}

/** Helper to safely extract a boolean from params */
export function paramBool(params: Params, key: string): boolean | undefined {
  const val = params[key];
  return typeof val === 'boolean' ? val : undefined;
}

/**
 * Require a string param at the MCP dispatch boundary.
 *
 * Throws before any vault call when the param is missing or wrong-typed,
 * so a malformed client call cannot reach a sink like `vault.modify` with
 * `String(undefined) === "undefined"` and corrupt the file (#210). `hint`
 * is appended to the message when set — use it to point callers at the
 * right tool/shape when a known misuse is likely.
 */
export function requireParamStr(
  params: Params,
  key: string,
  action: string,
  hint?: string,
): string {
  const val = params[key];
  if (typeof val !== 'string') {
    const have = val === undefined ? 'missing' : `got ${typeof val}`;
    const base = `${action} requires '${key}' (string, ${have}).`;
    throw new Error(hint ? `${base} ${hint}` : base);
  }
  return val;
}
