import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, ApiError, API_BASE } from "./api";

function mockFetch(impl: typeof fetch) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("apiFetch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefixes the path with the API base and parses JSON", async () => {
    mockFetch(async () => jsonResponse({ ok: true }));
    const data = await apiFetch<{ ok: boolean }>("/events");
    expect(data).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith(`${API_BASE}/events`, expect.any(Object));
  });

  it("serializes a JSON body and sets Content-Type for writes", async () => {
    mockFetch(async () => jsonResponse({ id: 1 }));
    await apiFetch("/rules", { method: "POST", body: { name: "r" } });
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ name: "r" }));
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("returns undefined for an empty (204) body", async () => {
    mockFetch(async () => new Response(null, { status: 204 }));
    const data = await apiFetch("/dispatches/1", { method: "DELETE" });
    expect(data).toBeUndefined();
  });

  it("throws ApiError with the server's error message on non-2xx", async () => {
    mockFetch(async () =>
      jsonResponse({ error: "not found" }, { status: 404 }),
    );
    await expect(apiFetch("/missing")).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      message: "not found",
    });
  });

  it("falls back to a status message when the error body has no message", async () => {
    mockFetch(async () => jsonResponse({}, { status: 500 }));
    const err = (await apiFetch("/boom").catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toContain("500");
  });

  it("wraps transport failures as ApiError with status 0", async () => {
    mockFetch(async () => {
      throw new TypeError("network down");
    });
    await expect(apiFetch("/x")).rejects.toMatchObject({
      name: "ApiError",
      status: 0,
      message: "network down",
    });
  });

  it("propagates aborts as AbortError, not ApiError", async () => {
    mockFetch(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    const err = (await apiFetch("/x").catch((e) => e)) as DOMException;
    expect(err).toBeInstanceOf(DOMException);
    expect(err.name).toBe("AbortError");
  });
});
