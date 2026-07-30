import type { Trigger } from "../services/triggerScheduler";

import {
  ModuleRegistry,
  type Capability,
  type OrchestratorModule,
  type Producer,
} from "./registry";

const MANUAL: Trigger = { kind: "manual" };

function producer(id: string): Producer {
  return { id, tick: async () => {}, defaultTrigger: MANUAL };
}

function capability(id: string, content = "x"): Capability {
  return {
    id,
    fetch: async (_config, subjectRef) => ({ label: id, content: `${content}:${subjectRef}` }),
  };
}

function moduleOf(
  id: string,
  producers: Producer[] = [],
  capabilities: Capability[] = []
): OrchestratorModule {
  return { id, producers, capabilities };
}

describe("ModuleRegistry", () => {
  it("indexes producers and capabilities by id", () => {
    const registry = new ModuleRegistry();
    const p = producer("poll.a");
    const c = capability("cap.a");
    registry.register(moduleOf("mod.a", [p], [c]));

    expect(registry.getModule("mod.a")?.id).toBe("mod.a");
    expect(registry.getProducer("poll.a")).toBe(p);
    expect(registry.getCapability("cap.a")).toBe(c);
    expect(registry.getProducer("nope")).toBeUndefined();
    expect(registry.getCapability("nope")).toBeUndefined();
  });

  it("lists modules, producers, and capabilities in registration order", () => {
    const registry = new ModuleRegistry();
    registry.register(moduleOf("mod.a", [producer("p1"), producer("p2")], [capability("c1")]));
    registry.register(moduleOf("mod.b", [producer("p3")], [capability("c2")]));

    expect(registry.listModules().map((m) => m.id)).toEqual(["mod.a", "mod.b"]);
    expect(registry.listProducers().map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    expect(registry.listCapabilities().map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("maps a capability to its owning module and lists descriptors", () => {
    const registry = new ModuleRegistry();
    registry.register(moduleOf("mod.a", [], [capability("c1"), capability("c2")]));
    registry.register(moduleOf("mod.b", [], [capability("c3")]));

    expect(registry.getCapabilityOwner("c1")).toBe("mod.a");
    expect(registry.getCapabilityOwner("c3")).toBe("mod.b");
    expect(registry.getCapabilityOwner("nope")).toBeUndefined();

    expect(registry.listCapabilityDescriptors()).toEqual([
      { id: "c1", module_id: "mod.a" },
      { id: "c2", module_id: "mod.a" },
      { id: "c3", module_id: "mod.b" },
    ]);
  });

  it("treats omitted producers/capabilities as empty", () => {
    const registry = new ModuleRegistry();
    registry.register({ id: "bare" });
    expect(registry.listProducers()).toEqual([]);
    expect(registry.listCapabilities()).toEqual([]);
  });

  it("rejects a duplicate module id", () => {
    const registry = new ModuleRegistry();
    registry.register(moduleOf("dup"));
    expect(() => registry.register(moduleOf("dup"))).toThrow(/duplicate module id: dup/);
  });

  it("rejects a duplicate producer id across modules", () => {
    const registry = new ModuleRegistry();
    registry.register(moduleOf("mod.a", [producer("shared")]));
    expect(() => registry.register(moduleOf("mod.b", [producer("shared")]))).toThrow(
      /duplicate producer id: shared/
    );
  });

  it("rejects a duplicate capability id across modules", () => {
    const registry = new ModuleRegistry();
    registry.register(moduleOf("mod.a", [], [capability("shared")]));
    expect(() => registry.register(moduleOf("mod.b", [], [capability("shared")]))).toThrow(
      /duplicate capability id: shared/
    );
  });

  it("does not partially register a module that collides mid-list", () => {
    const registry = new ModuleRegistry();
    registry.register(moduleOf("mod.a", [producer("p1")]));
    // p1 collides; p2 must NOT be registered, and the module must be absent.
    expect(() =>
      registry.register(moduleOf("mod.b", [producer("p2"), producer("p1")]))
    ).toThrow(/duplicate producer id: p1/);
    expect(registry.getModule("mod.b")).toBeUndefined();
    expect(registry.getProducer("p2")).toBeUndefined();
  });

  describe("dynamic producers", () => {
    it("adds a producer after registration and surfaces it on the module", () => {
      const registry = new ModuleRegistry();
      registry.register(moduleOf("mod.a"));
      const p = producer("mod.a.dyn");

      registry.registerProducer("mod.a", p);

      expect(registry.getProducer("mod.a.dyn")).toBe(p);
      expect(registry.getModule("mod.a")?.producers?.map((x) => x.id)).toEqual([
        "mod.a.dyn",
      ]);
      expect(registry.listProducers().map((x) => x.id)).toEqual(["mod.a.dyn"]);
    });

    it("rejects a dynamic producer for an unknown module", () => {
      const registry = new ModuleRegistry();
      expect(() => registry.registerProducer("nope", producer("p"))).toThrow(
        /unknown module id: nope/
      );
    });

    it("rejects a dynamic producer whose id collides", () => {
      const registry = new ModuleRegistry();
      registry.register(moduleOf("mod.a", [producer("p1")]));
      expect(() => registry.registerProducer("mod.a", producer("p1"))).toThrow(
        /duplicate producer id: p1/
      );
    });

    it("unregisters a producer from the index and its owning module", () => {
      const registry = new ModuleRegistry();
      registry.register(moduleOf("mod.a"));
      registry.registerProducer("mod.a", producer("mod.a.dyn"));

      registry.unregisterProducer("mod.a.dyn");

      expect(registry.getProducer("mod.a.dyn")).toBeUndefined();
      expect(registry.getModule("mod.a")?.producers).toEqual([]);
    });

    it("is a no-op when unregistering an unknown producer", () => {
      const registry = new ModuleRegistry();
      registry.register(moduleOf("mod.a", [producer("p1")]));
      expect(() => registry.unregisterProducer("ghost")).not.toThrow();
      expect(registry.getProducer("p1")).toBeDefined();
    });
  });

  it("exposes read-only capability fetch that returns a labelled blob", async () => {
    const registry = new ModuleRegistry();
    registry.register(moduleOf("mod.a", [], [capability("cap.a", "body")]));
    const result = await registry.getCapability("cap.a")!.fetch({}, "ref-1");
    expect(result).toEqual({ label: "cap.a", content: "body:ref-1" });
  });

  describe("onConfigChanged", () => {
    it("loads config and passes it to the module's applyConfig hook", async () => {
      const applied: unknown[] = [];
      const registry = new ModuleRegistry({
        loadConfig: async (id) => ({ forModule: id, n: 7 }),
      });
      registry.register({
        id: "mod.a",
        applyConfig: (config) => {
          applied.push(config);
        },
      });

      await registry.onConfigChanged("mod.a");
      expect(applied).toEqual([{ forModule: "mod.a", n: 7 }]);
    });

    it("awaits an async applyConfig hook", async () => {
      let done = false;
      const registry = new ModuleRegistry({ loadConfig: async () => ({}) });
      registry.register({
        id: "mod.a",
        applyConfig: async () => {
          await Promise.resolve();
          done = true;
        },
      });

      await registry.onConfigChanged("mod.a");
      expect(done).toBe(true);
    });

    it("is a no-op for an unknown module or one without applyConfig", async () => {
      let loads = 0;
      const registry = new ModuleRegistry({
        loadConfig: async () => {
          loads += 1;
          return {};
        },
      });
      registry.register(moduleOf("no-hook"));

      await expect(registry.onConfigChanged("no-hook")).resolves.toBeUndefined();
      await expect(registry.onConfigChanged("absent")).resolves.toBeUndefined();
      // No hook means we never bother loading config.
      expect(loads).toBe(0);
    });

    it("propagates an error thrown by applyConfig", async () => {
      const registry = new ModuleRegistry({ loadConfig: async () => ({}) });
      registry.register({
        id: "mod.a",
        applyConfig: () => {
          throw new Error("bad config");
        },
      });

      await expect(registry.onConfigChanged("mod.a")).rejects.toThrow(/bad config/);
    });
  });
});
