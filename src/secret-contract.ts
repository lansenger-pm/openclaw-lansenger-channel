import type { SecretTargetRegistryEntry, ResolverContext, SecretDefaults } from "openclaw/plugin-sdk/channel-secret-runtime";
import {
  getChannelSurface,
  collectSimpleChannelFieldAssignments,
} from "openclaw/plugin-sdk/channel-secret-runtime";

// ── Target Registry ──────────────────────────────────────────
// Registers the appSecret field so the framework knows it's a
// secret-bearing value. This enables `openclaw secrets configure`,
// `openclaw secrets audit`, and automatic SecretRef migration.

const secretTargetRegistryEntries: readonly SecretTargetRegistryEntry[] = [
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

// ── Runtime Assignment ────────────────────────────────────
// At runtime, resolves SecretRef values so that resolveAccount()
// sees the real appSecret rather than a ref string.

function collectRuntimeConfigAssignments(params: {
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

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
