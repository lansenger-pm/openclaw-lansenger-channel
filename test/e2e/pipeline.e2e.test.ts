import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { vi } from "vitest";
import { FakeLansengerServer, dmEvent } from "./fake-lansenger-server.js";
import { makeMiniHost, waitFor, cleanupRuntime } from "./helpers.js";
import { startLansengerGateway, getRunningClient, _clearTestState } from "../../src/runtime.js";

/**
 * E2E Layer B — inbound pipeline: REAL runtime.ts (policies, debounce, routing,
 * ack, pairing) + REAL client + REAL fake server. Only the OpenClaw host surface
 * (agent turn) is stubbed. Inbound events enter through the actual WS push.
 */
describe("E2E: inbound pipeline (real runtime, real wire)", () => {
  let server: FakeLansengerServer;

  beforeAll(async () => {
    server = new FakeLansengerServer({ pingIntervalSec: 1 });
    await server.start();
  });
  afterAll(async () => {
    await server.stop();
    _clearTestState();
  });
  beforeEach(async () => {
    await cleanupRuntime(getRunningClient, server);
    server.apiCalls.length = 0;
  });

  async function startWith(cfgOverrides: Record<string, any> = {}): Promise<any> {
    const api = makeMiniHost(server, cfgOverrides);
    startLansengerGateway(api);
    await waitFor(() => server.connectionCount("app-1") === 1 && getRunningClient()?.isWsAlive() === true, 5_000, "account connected (server-side)");
    return api;
  }

  it("DM (dmPolicy=open) → debounced → routed to agent with correct text and sessionKey", async () => {
    const api = await startWith();
    server.pushEvent("app-1", dmEvent({ msgData: { text: { content: "e2e hello" } } }));
    await waitFor(() => api._inboundRuns.length === 1, 5_000, "inbound.run called");
    const runJson = JSON.stringify(api._inboundRuns[0]);
    expect(runJson).toContain("e2e hello");
  }, 15_000);

  it("dmPolicy=allowlist: sender NOT in list → message dropped (no agent turn, no outbound)", async () => {
    const api = await startWith({
      channels: {
        lansenger: {
          dmPolicy: "allowlist",
          allowFrom: ["user-9"],
          accounts: { "acc-1": { appId: "app-1", appSecret: "test-secret", apiGatewayUrl: server.httpUrl, homeChannel: "user-1" } },
        },
      },
    });
    server.pushEvent("app-1", dmEvent({ from: "user-1", conversationId: "user-1" })); // user-1 NOT in allowFrom
    await new Promise((r) => setTimeout(r, 1_500));
    expect(api._inboundRuns).toHaveLength(0);
    expect(server.calls("/v1/bot/messages/create")).toHaveLength(0);
  }, 15_000);

  it("dmPolicy=allowlist: allowed sender → processed", async () => {
    const api = await startWith({
      channels: {
        lansenger: {
          dmPolicy: "allowlist",
          allowFrom: ["user-1"],
          accounts: { "acc-1": { appId: "app-1", appSecret: "test-secret", apiGatewayUrl: server.httpUrl, homeChannel: "user-1" } },
        },
      },
    });
    server.pushEvent("app-1", dmEvent({ from: "user-1", conversationId: "user-1" }));
    await waitFor(() => api._inboundRuns.length === 1, 5_000, "allowed sender processed");
  }, 15_000);

  it("debounce merges rapid consecutive messages into ONE agent turn", async () => {
    const api = await startWith({ messages: { inbound: { debounceMs: 300 } } });
    server.pushEvent("app-1", dmEvent({ msgData: { text: { content: "part one" } }, messageId: "m-a" }));
    await new Promise((r) => setTimeout(r, 80));
    server.pushEvent("app-1", dmEvent({ msgData: { text: { content: "part two" } }, messageId: "m-b" }));
    await waitFor(() => api._inboundRuns.length === 1, 5_000, "merged flush");
    await new Promise((r) => setTimeout(r, 500));
    expect(api._inboundRuns).toHaveLength(1); // still exactly one turn — merged, not duplicated
    const run = api._inboundRuns[0];
    expect(JSON.stringify(run)).toContain("part one");
    expect(JSON.stringify(run)).toContain("part two");
  }, 15_000);

  it("ackMessage=true → the plugin itself sends the ack through the real HTTP stack", async () => {
    const api = await startWith({
      channels: {
        lansenger: {
          accounts: { "acc-1": { appId: "app-1", appSecret: "test-secret", apiGatewayUrl: server.httpUrl, homeChannel: "user-1", ackMessage: true } },
        },
      },
    });
    server.pushEvent("app-1", dmEvent({ msgData: { text: { content: "你好机器人" } } }));
    await waitFor(() => server.calls("/v1/bot/messages/create").length >= 1, 5_000, "ack sent over real HTTP");
    const ackBody = server.calls("/v1/bot/messages/create")[0]!.body;
    expect(ackBody.userIdList).toContain("user-1");
    expect(ackBody.msgData.formatText.text).toContain("收到"); // Chinese message → Chinese ack
  }, 15_000);

  it("dmPolicy=pairing: unknown sender gets a pairing-code reply over real HTTP", async () => {
    const api = await startWith({
      channels: {
        lansenger: {
          dmPolicy: "pairing",
          accounts: { "acc-1": { appId: "app-1", appSecret: "test-secret", apiGatewayUrl: server.httpUrl, homeChannel: "user-1" } },
        },
      },
    });
    server.pushEvent("app-1", dmEvent({ from: "stranger-1", conversationId: "stranger-1" }));
    await waitFor(() => server.calls("/v1/bot/messages/create").length >= 1, 5_000, "pairing reply sent");
    const body = server.calls("/v1/bot/messages/create")[0]!.body;
    expect(body.userIdList).toContain("stranger-1");
    expect(JSON.stringify(body)).toContain("PAIR123"); // from the mini-host pairing stub
    expect(api._inboundRuns).toHaveLength(0); // message itself dropped until paired
  }, 15_000);

  it("group message without mention is dropped when requireMention is on", async () => {
    const api = await startWith({
      channels: {
        lansenger: {
          accounts: { "acc-1": { appId: "app-1", appSecret: "test-secret", apiGatewayUrl: server.httpUrl, homeChannel: "user-1" } },
        },
      },
    });
    // realistic host stub: mention required (production default)
    api.runtime.channel.groups.resolveRequireMention = () => true;
    server.pushEvent("app-1", {
      msgType: "text", msgData: { text: { content: "not mentioning anyone" } }, messageId: "gm-1",
      chatType: "group", from: "user-1", groupId: "g-1", groupName: "G",
      reminder: { isAtMe: false, isAtAll: false },
    }, "bot_group_message");
    await new Promise((r) => setTimeout(r, 1_500));
    expect(api._inboundRuns).toHaveLength(0);

    // …and WITH a mention it goes through
    server.pushEvent("app-1", {
      msgType: "text", msgData: { text: { content: "hey @bot" } }, messageId: "gm-2",
      chatType: "group", from: "user-1", groupId: "g-1", groupName: "G",
      reminder: { isAtMe: true, isAtAll: false },
    }, "bot_group_message");
    await waitFor(() => api._inboundRuns.length === 1, 5_000, "mentioned message processed");
  }, 15_000);
});