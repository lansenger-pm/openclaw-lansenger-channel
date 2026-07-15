/**
 * Standalone secret contract API for OpenClaw CLI discovery.
 *
 * The `openclaw secrets configure/audit` commands load this file directly
 * (looking for `dist/secret-contract-api.js`) rather than reading
 * `plugin.secrets` from the runtime plugin object.  The exports must
 * therefore be top-level named exports.
 */
import type { SecretTargetRegistryEntry, ResolverContext, SecretDefaults } from "openclaw/plugin-sdk/channel-secret-runtime";
import {
  getChannelSurface,
  collectSimpleChannelFieldAssignments,
} from "openclaw/plugin-sdk/channel-secret-runtime";

export const secretTargetRegistryEntries: readonly SecretTargetRegistryEntry[] = [
  {
    id: "channels.lansenger.accounts.*.appSecret",
    targetType: "channels.lansenger.appSecret",
    configFile: "openclaw.json",
    pathPattern: "channels.lansenger.accounts.*.appSecret",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    accountIdPathSegmentIndex: 3,
  },
  {
    id: "channels.lansenger.appSecret",
    targetType: "channels.lansenger.appSecret",
    configFile: "openclaw.json",
    pathPattern: "channels.lansenger.appSecret",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
];

export function collectRuntimeConfigAssignments(params: {
  config: Record<string, unknown>;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "lansenger");
  if (!resolved) return;

  const { channel, surface } = resolved;
  collectSimpleChannelFieldAssignments({
    channelKey: "lansenger",
    field: "appSecret",
    channel: channel as Record<string, unknown>,
    surface,
    defaults: params.defaults,
    context: params.context,
    topInactiveReason: "Lansenger channel is not enabled.",
    accountInactiveReason: "Lansenger account is disabled.",
  });
}
