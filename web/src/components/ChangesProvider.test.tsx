import { useEffect } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  subscribeChangeStream,
  type ChangeStreamHandlers,
} from "../changes";
import { ChangesProvider, useChanges } from "./ChangesProvider";

// The provider is driven entirely by the change stream; mock it so tests can
// hand-feed frames and reconnects without a real EventSource.
vi.mock("../changes", () => ({
  subscribeChangeStream: vi.fn(),
}));

const mockSubscribe = vi.mocked(subscribeChangeStream);

/** Captured stream handlers so a test can push frames / simulate a reconnect. */
let handlers: ChangeStreamHandlers | null = null;
const closeStream = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  handlers = null;
  mockSubscribe.mockImplementation((h) => {
    handlers = h;
    return closeStream;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** Push a change frame for `resource` through the mocked stream. */
function emit(resource: string) {
  act(() => {
    handlers?.onChange({ resource, ts: 0 });
  });
}

/**
 * A probe that registers `cb` for `resource` via the provider and returns a
 * handle so a test can unmount it. Exercises the real subscribe/unsubscribe.
 */
function Probe({
  resource,
  cb,
}: {
  resource: string;
  cb: () => void;
}) {
  const { subscribe } = useChanges();
  useEffect(() => subscribe(resource, cb), [subscribe, resource, cb]);
  return null;
}

describe("ChangesProvider", () => {
  it("opens exactly one shared EventSource for the whole app", () => {
    const cb = vi.fn();
    render(
      <ChangesProvider>
        <Probe resource="playbooks" cb={cb} />
        <Probe resource="rules" cb={cb} />
      </ChangesProvider>,
    );
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
  });

  it("invokes a resource's callback on its change frame", () => {
    const cb = vi.fn();
    render(
      <ChangesProvider>
        <Probe resource="playbooks" cb={cb} />
      </ChangesProvider>,
    );
    emit("playbooks");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("does not invoke a callback for an unrelated resource", () => {
    const cb = vi.fn();
    render(
      <ChangesProvider>
        <Probe resource="playbooks" cb={cb} />
      </ChangesProvider>,
    );
    emit("rules");
    expect(cb).not.toHaveBeenCalled();
  });

  it("throttles bursts to one leading + one trailing call per ~1s", () => {
    const cb = vi.fn();
    render(
      <ChangesProvider>
        <Probe resource="events" cb={cb} />
      </ChangesProvider>,
    );

    // A burst of frames inside one window: leading edge fires once immediately.
    emit("events");
    emit("events");
    emit("events");
    expect(cb).toHaveBeenCalledTimes(1);

    // The trailing edge fires exactly once more when the window elapses.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(cb).toHaveBeenCalledTimes(2);

    // Nothing further arrived: the window closes with no extra call.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("allows one call per window across successive windows", () => {
    const cb = vi.fn();
    render(
      <ChangesProvider>
        <Probe resource="events" cb={cb} />
      </ChangesProvider>,
    );

    emit("events"); // leading edge, window 1
    expect(cb).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(1000); // window 1 closes, nothing pending
    });
    expect(cb).toHaveBeenCalledTimes(1);

    emit("events"); // leading edge of a fresh window
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("refetches every registered resource once on reconnect", () => {
    const playbooks = vi.fn();
    const rules = vi.fn();
    render(
      <ChangesProvider>
        <Probe resource="playbooks" cb={playbooks} />
        <Probe resource="rules" cb={rules} />
      </ChangesProvider>,
    );

    // The first open is the initial connection — no catch-up (the pages already
    // loaded).
    act(() => {
      handlers?.onOpen?.();
    });
    expect(playbooks).not.toHaveBeenCalled();
    expect(rules).not.toHaveBeenCalled();

    // A subsequent open is a reconnect: every registered resource refetches once.
    act(() => {
      handlers?.onOpen?.();
    });
    expect(playbooks).toHaveBeenCalledTimes(1);
    expect(rules).toHaveBeenCalledTimes(1);
  });

  it("stops invoking a callback after its subscriber unmounts", () => {
    const cb = vi.fn();
    const { rerender } = render(
      <ChangesProvider>
        <Probe resource="playbooks" cb={cb} />
      </ChangesProvider>,
    );
    emit("playbooks");
    expect(cb).toHaveBeenCalledTimes(1);

    // Unmount the probe; its subscription is torn down.
    rerender(<ChangesProvider />);
    emit("playbooks");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("isolates a throwing callback from its peers", () => {
    const boom = vi.fn(() => {
      throw new Error("refetch failed");
    });
    const ok = vi.fn();
    render(
      <ChangesProvider>
        <Probe resource="events" cb={boom} />
        <Probe resource="events" cb={ok} />
      </ChangesProvider>,
    );
    expect(() => emit("events")).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("closes the stream on unmount", () => {
    const { unmount } = render(<ChangesProvider />);
    unmount();
    expect(closeStream).toHaveBeenCalledTimes(1);
  });
});
