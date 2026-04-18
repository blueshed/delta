/**
 * Unit tests for the auth extension surface — interface wiring only,
 * no database required.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { createWs } from "../src/server/server";
import {
  wireAuth,
  upgradeWithAuth,
  isAuthError,
  type DeltaAuth,
} from "../src/server/auth";
import { setLogLevel } from "../src/server/logger";

setLogLevel("silent");

// ---------------------------------------------------------------------------
// Helpers — minimal mocks for the WsServer contract.
// ---------------------------------------------------------------------------

function mockClient(data: Record<string, unknown> = {}) {
  return {
    data,
    sent: [] as any[],
    subscriptions: new Set<string>(),
    readyState: 1,
    send(msg: any) { this.sent.push(JSON.parse(msg)); },
    subscribe(ch: string) { this.subscriptions.add(ch); },
    unsubscribe(ch: string) { this.subscriptions.delete(ch); },
  };
}

// Drive the first registered "call" handler for a given action.
async function invoke(
  ws: ReturnType<typeof createWs>,
  client: any,
  msg: any,
): Promise<any> {
  return new Promise((resolve) => {
    ws.websocket.message(client, JSON.stringify({ id: 1, ...msg }));
    setTimeout(() => {
      const response = client.sent.find((m: any) => m.id === 1);
      resolve(response);
    }, 5);
  });
}

// ---------------------------------------------------------------------------
// isAuthError
// ---------------------------------------------------------------------------

describe("isAuthError", () => {
  test("detects { error } objects", () => {
    expect(isAuthError({ error: "nope" })).toBe(true);
  });
  test("rejects identity values", () => {
    expect(isAuthError({ id: 1 })).toBe(false);
    expect(isAuthError("user")).toBe(false);
    expect(isAuthError(42)).toBe(false);
    expect(isAuthError(null)).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// wireAuth — registers auth.actions as WS "call" handlers.
// ---------------------------------------------------------------------------

describe("wireAuth", () => {
  test("noop when auth.actions is undefined", () => {
    const ws = createWs();
    const auth: DeltaAuth = { gate: () => ({ error: "no" }) };
    wireAuth(ws, auth);
    // No throws — and no call handler is registered.
    expect(true).toBe(true);
  });

  test("dispatches call → action, returning { result }", async () => {
    const ws = createWs();
    const auth: DeltaAuth<{ id: number }> = {
      actions: {
        async login(params, client) {
          client.data.identity = { id: 42 };
          return { result: { id: 42, token: "abc" } };
        },
      },
      gate: (c) => c.data.identity ?? { error: "Authentication required" },
    };
    wireAuth(ws, auth);

    const client = mockClient();
    const res = await invoke(ws, client, {
      action: "call",
      method: "login",
      params: { email: "a", password: "b" },
    });

    expect(res.result).toEqual({ id: 42, token: "abc" });
    expect(client.data.identity).toEqual({ id: 42 });
  });

  test("action returning { error } → 401", async () => {
    const ws = createWs();
    const auth: DeltaAuth = {
      actions: {
        async login() { return { error: "bad" }; },
      },
      gate: () => ({ error: "no" }),
    };
    wireAuth(ws, auth);

    const client = mockClient();
    const res = await invoke(ws, client, { action: "call", method: "login", params: {} });

    expect(res.error).toEqual({ code: 401, message: "bad" });
  });

  test("unknown method is ignored (falls through to no-handler-matched)", async () => {
    const ws = createWs();
    const auth: DeltaAuth = {
      actions: { async login() { return { result: {} }; } },
      gate: () => ({ error: "no" }),
    };
    wireAuth(ws, auth);

    const client = mockClient();
    const res = await invoke(ws, client, { action: "call", method: "other" });

    expect(res.error?.message).toMatch(/No handler matched/);
  });
});

// ---------------------------------------------------------------------------
// upgradeWithAuth — runs auth.onUpgrade, stashes identity on client.data.
// ---------------------------------------------------------------------------

describe("upgradeWithAuth", () => {
  function mockServer() {
    const upgraded: { req: Request; opts: any }[] = [];
    return {
      upgraded,
      upgrade(req: Request, opts: any) { upgraded.push({ req, opts }); return true; },
    } as any;
  }

  test("identity from onUpgrade lands on client.data.identity", async () => {
    const ws = createWs();
    const auth: DeltaAuth<{ id: number }> = {
      onUpgrade: (req) => {
        const authz = req.headers.get("authorization");
        return authz === "Bearer valid" ? { id: 7 } : null;
      },
      gate: (c) => c.data.identity ?? { error: "nope" },
    };
    const handler = upgradeWithAuth(ws, auth);
    const server = mockServer();

    const req = new Request("http://localhost/ws?clientId=abc", {
      headers: { authorization: "Bearer valid" },
    });
    await handler(req, server);

    expect(server.upgraded[0].opts.data.identity).toEqual({ id: 7 });
    expect(server.upgraded[0].opts.data.clientId).toBe("abc");
  });

  test("no token → identity null, upgrade still happens (deferred auth)", async () => {
    const ws = createWs();
    const auth: DeltaAuth = {
      onUpgrade: () => null,
      gate: () => ({ error: "nope" }),
    };
    const handler = upgradeWithAuth(ws, auth);
    const server = mockServer();

    const req = new Request("http://localhost/ws");
    await handler(req, server);

    expect(server.upgraded[0].opts.data.identity).toBe(null);
    expect(server.upgraded[0].opts.data.clientId).toBeDefined();
  });

  test("onUpgrade throwing treated as null identity", async () => {
    const ws = createWs();
    const auth: DeltaAuth = {
      onUpgrade: () => { throw new Error("boom"); },
      gate: () => ({ error: "nope" }),
    };
    const handler = upgradeWithAuth(ws, auth);
    const server = mockServer();

    const req = new Request("http://localhost/ws");
    await handler(req, server);

    expect(server.upgraded[0].opts.data.identity).toBe(null);
  });
});
