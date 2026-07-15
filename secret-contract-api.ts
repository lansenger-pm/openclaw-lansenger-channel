/**
 * Standalone secret contract API for OpenClaw CLI discovery.
 *
 * The `openclaw secrets configure/audit` commands load this file directly
 * (looking for `dist/secret-contract-api.js`) rather than reading
 * `plugin.secrets` from the runtime plugin object.  The exports must
 * therefore be top-level named exports.
 */
import { channelSecrets } from "./src/secret-contract.js";

export const secretTargetRegistryEntries = channelSecrets.secretTargetRegistryEntries;
export const collectRuntimeConfigAssignments = channelSecrets.collectRuntimeConfigAssignments;
