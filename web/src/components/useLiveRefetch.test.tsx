import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChangesContextValue,
  useChanges,
} from "./ChangesProvider";
import { useLiveRefetch } from "./useLiveRefetch";

// Drive the hook against a stub context so the test isolates its
// register/unregister behavior from the real EventSource plumbing.
vi.mock("./ChangesProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ChangesProvider")>();
  return { ...actual, useChanges: vi.fn() };
});

const mockUseChanges = vi.mocked(useChanges);

/** A stub provider that records subscriptions and can fire a resource. */
function makeStubContext() {
  const registry = new Map<string, Set<() => void>>();
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((resource: string, cb: () => void) => {
    let set = registry.get(resource);
    if (!set) {
      set = new Set();
      registry.set(resource, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
      unsubscribe();
    };
  });
  const fire = (resource: string) => {
    for (const cb of registry.get(resource) ?? []) cb();
  };
  return { value: { subscribe } as ChangesContextValue, subscribe, unsubscribe, fire };
}

function Consumer({ resource, refetch }: { resource: string; refetch: () => void }) {
  useLiveRefetch(resource, refetch);
  return null;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("useLiveRefetch", () => {
  it("registers for its resource on mount", () => {
    const ctx = makeStubContext();
    mockUseChanges.mockReturnValue(ctx.value);
    render(<Consumer resource="playbooks" refetch={vi.fn()} />);
    expect(ctx.subscribe).toHaveBeenCalledTimes(1);
    expect(ctx.subscribe).toHaveBeenCalledWith("playbooks", expect.any(Function));
  });

  it("runs the refetch when its resource fires", () => {
    const ctx = makeStubContext();
    mockUseChanges.mockReturnValue(ctx.value);
    const refetch = vi.fn();
    render(<Consumer resource="rules" refetch={refetch} />);
    ctx.fire("rules");
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("always calls the latest refetch without re-subscribing", () => {
    const ctx = makeStubContext();
    mockUseChanges.mockReturnValue(ctx.value);
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Consumer resource="events" refetch={first} />);
    // A new refetch identity (as when the page's query state changes) must not
    // churn the subscription, but the newest one must be the one invoked.
    rerender(<Consumer resource="events" refetch={second} />);
    expect(ctx.subscribe).toHaveBeenCalledTimes(1);
    ctx.fire("events");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("unregisters on unmount", () => {
    const ctx = makeStubContext();
    mockUseChanges.mockReturnValue(ctx.value);
    const { unmount } = render(<Consumer resource="snippets" refetch={vi.fn()} />);
    unmount();
    expect(ctx.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
