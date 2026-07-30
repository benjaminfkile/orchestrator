import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDispatch,
  listDispatches,
  rerunDispatch,
  retryDispatch,
} from "./dispatches";
import { API_BASE } from "./api";

function mockFetch(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

/** The `[url, init]` the last fetch was issued with. */
function lastCall(): [string, RequestInit] {
  const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
  return [String(call[0]), call[1] as RequestInit];
}

describe("dispatches helpers", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("lists all dispatches with no query when unfiltered", async () => {
    mockFetch([]);
    await listDispatches();
    expect(lastCall()[0]).toBe(`${API_BASE}/dispatches`);
  });

  it("lists dispatches filtered by status", async () => {
    mockFetch([]);
    await listDispatches({ status: "failed" });
    expect(lastCall()[0]).toBe(`${API_BASE}/dispatches?status=failed`);
  });

  it("lists only active dispatches with active=1", async () => {
    mockFetch([]);
    await listDispatches({ active: true });
    expect(lastCall()[0]).toBe(`${API_BASE}/dispatches?active=1`);
  });

  it("retries a dispatch with a POST", async () => {
    mockFetch({ id: 1, status: "queued" });
    await retryDispatch(1);
    const [url, init] = lastCall();
    expect(url).toBe(`${API_BASE}/dispatches/1/retry`);
    expect(init.method).toBe("POST");
  });

  it("creates a rule-less dispatch from an event + playbook id", async () => {
    const created = { id: 9, event_id: 3, playbook_id: 5, status: "queued" };
    mockFetch(created);
    expect(await createDispatch(3, 5)).toEqual(created);

    const [url, init] = lastCall();
    expect(url).toBe(`${API_BASE}/dispatches`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ event_id: 3, playbook_id: 5 }));
    expect(
      (init.headers as Record<string, string>)["Content-Type"],
    ).toBe("application/json");
  });

  it("re-runs a dispatch by resolving its event+playbook, then re-creating it", async () => {
    // Both fetches (GET the detail, then POST a new dispatch) hit the same stub;
    // the detail carries the event/playbook ids the re-run reuses.
    const detail = { id: 5, event_id: 3, playbook_id: 7, status: "done", runs: [] };
    mockFetch(detail);
    await rerunDispatch(5);

    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(String(calls[0][0])).toBe(`${API_BASE}/dispatches/5`);
    const [url, init] = calls[1] as [string, RequestInit];
    expect(String(url)).toBe(`${API_BASE}/dispatches`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ event_id: 3, playbook_id: 7 }));
  });
});
