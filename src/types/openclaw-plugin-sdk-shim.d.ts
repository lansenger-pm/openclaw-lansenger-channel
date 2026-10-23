// Dual-version compat shim (3.18.9): OpenClaw 2026.8.1 exports the
// `openclaw/plugin-sdk/command-surface` subpath at runtime but ships no
// declaration file for it (2026.7.1 and 2026.10.x do). Declare the subset
// we consume; TS prefers the real d.ts when the host provides one.
declare module "openclaw/plugin-sdk/command-surface" {
  export function normalizeCommandBody(
    raw: string,
    options?: { preserveArguments?: boolean; botUsername?: string; targetedCommandMode?: string },
  ): string;
}
