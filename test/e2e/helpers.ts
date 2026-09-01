import { vi } from "vitest";
import type { FakeLansengerServer } from "./fake-lansenger-server.js";
import { _clearTestState } from "../../src/runtime.js";

/**
 * Mini-host harness for pipeline E2E: runs the REAL plugin runtime
 * (startLansengerGateway / gatewayStartAccount / handleInbound / patrol) against a
 * REAL FakeLansengerServer connection. Only the OpenClaw host surface (agent turn,
 * routing, pairing store) is stubbed — everything else is production plugin code.
 */
export function makeMiniHost(server: FakeLansengerServer, cfgOverrides: Record<string, any> = {}): any {
  const methods: Record<string, any> = {};
  const inboundRuns: any[] = [];
  const inboundRunSpy = vi.fn(async (_params?: any) => {});

  const api: any = {
    _methods: methods,
    _inboundRuns: inboundRuns,
    config: {
      channels: {
        lansenger: {
          dmPolicy: "open",
          accounts: {
            "acc-1": { appId: "app-1", appSecret: "test-secret", apiGatewayUrl: server.httpUrl, homeChannel: "user-1" },
          },
          ...cfgOverrides.channels?.lansenger,
        },
      },
      messages: cfgOverrides.messages ?? { inbound: { debounceMs: 0 } },
      commands: cfgOverrides.commands ?? { ownerAllowFrom: ["lansenger:user-1"] },
    },
    registerGatewayMethod: (name: string, handler: any) => { methods[name] = handler; },
    registerHttpRoute: () => {},
    registerHook: () => {},
    on: () => {},
    runtime: {
      channel: {
        debounce: {},
        pairing: {
          readAllowFromStore: async () => [],
          upsertPairingRequest: async () => ({ code: "PAIR123" }),
          buildPairingReply: ({ code }: any) => `Pairing code: ${code}`,
        },
        groups: {
          resolveGroupPolicy: () => ({ allowed: true }),
          resolveRequireMention: () => false,
        },
        routing: {
          resolveAgentRoute: () => ({ agentId: "agent-1", sessionKey: "sess-1", matchedBy: "default" }),
        },
        commands: {
          shouldHandleTextCommands: () => false,
          shouldComputeCommandAuthorized: () => false,
          isControlCommandMessage: () => false,
        },
        turn: { run: async () => {} },
        inbound: {
          run: async (params: any) => {
            inboundRuns.push(params);
            return inboundRunSpy(params);
          },
        },
        session: {
          resolveStorePath: () => "/tmp/store",
          recordInboundSession: () => {},
        },
        reply: { dispatchReplyWithBufferedBlockDispatcher: () => {} },
      },
    },
  };
  return api;
}

/** Wait until predicate resolves truthy (poll interval 25ms). */
export async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`waitFor timeout (${timeoutMs}ms): ${what}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Test isolation: disconnect any leftover running client (clearing state alone
 * drops the reference but leaves the WS alive — the next test then sees 2
 * server-side connections and every count assertion breaks), then drain sockets.
 */
export async function cleanupRuntime(getRunningClient: () => any, server: any): Promise<void> {
  const client = getRunningClient();
  if (client) {
    try { await client.disconnect(); } catch { /* already dead */ }
  }
  _clearTestState();
  server.killAllSockets();
  await waitFor(() => {
    let total = 0;
    for (const set of server.socketsByAppId.values()) total += set.size;
    return total === 0;
  }, 3_000, "server sockets drained");
}