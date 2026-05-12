/**
 * Multi-bot binding manager — binds Lansenger bots to OpenClaw agents.
 * 
 * Supports:
 * - Multiple bots bound to different agents
 * - Dynamic binding via API
 * - Config-based initialization
 * - OpenClaw bindings format support
 */

export type BotBinding = {
  botId: string;      // Lansenger bot AppId
  agentId: string;    // OpenClaw agent ID
  lastUpdated: string; // ISO timestamp
};

export type BindingMatch = {
  channel: string;
  accountId: string;
};

export type OpenClawBinding = {
  match: BindingMatch;
  agentId: string;
};

export class BindingManager {
  private bindings: BotBinding[] = [];

  constructor() {}

  /** Bind a bot to an agent (creates or updates) */
  bindBotToAgent(botId: string, agentId: string): void {
    const idx = this.bindings.findIndex(b => b.botId === botId);
    if (idx >= 0) {
      this.bindings[idx] = { botId, agentId, lastUpdated: new Date().toISOString() };
    } else {
      this.bindings.push({ botId, agentId, lastUpdated: new Date().toISOString() });
    }
  }

  /** Remove a binding by botId */
  removeBinding(botId: string): boolean {
    const len = this.bindings.length;
    this.bindings = this.bindings.filter(b => b.botId !== botId);
    return this.bindings.length < len;
  }

  /** Check if a bot has a binding */
  hasBinding(botId: string): boolean {
    return this.bindings.some(b => b.botId === botId);
  }

  /** Get the agentId for a bot */
  getAgentId(botId: string): string | undefined {
    return this.bindings.find(b => b.botId === botId)?.agentId;
  }

  /** Get all bindings */
  getAllBindings(): BotBinding[] {
    return [...this.bindings];
  }

  /** Initialize bindings from config */
  initializeFromConfig(
    accounts: Record<string, { appId?: string; agentId?: string }>,
    openclawBindings?: OpenClawBinding[]
  ): void {
    // From account config (appId → agentId)
    if (accounts) {
      for (const [accountId, account] of Object.entries(accounts)) {
        if (account.appId && account.agentId) {
          this.bindBotToAgent(account.appId, account.agentId);
        }
      }
    }

    // From OpenClaw bindings format
    if (openclawBindings) {
      for (const binding of openclawBindings) {
        if (binding.match?.channel === "Lansenger" && binding.match?.accountId && binding.agentId) {
          // Find the account with matching appId
          if (accounts) {
            for (const [accountId, account] of Object.entries(accounts)) {
              if (accountId === binding.match.accountId && account.appId) {
                this.bindBotToAgent(account.appId, binding.agentId);
                break;
              }
            }
          }
        }
      }
    }
  }

  /** Clear all bindings */
  clear(): void {
    this.bindings = [];
  }
}

// Global singleton
let globalBindingManager: BindingManager | null = null;

export function getBindingManager(): BindingManager {
  if (!globalBindingManager) {
    globalBindingManager = new BindingManager();
  }
  return globalBindingManager;
}
