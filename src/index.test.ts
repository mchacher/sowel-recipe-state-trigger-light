import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRecipe } from "./index.js";

// ============================================================
// Lightweight RecipeContext fake (mirrors what Sowel core injects)
// ============================================================

const ROOT_ZONE_ID = "00000000-0000-0000-0000-000000000001";

interface Listener {
  type: string;
  fn: (event: Record<string, unknown>) => void;
}

function makeCtx(opts: {
  isDaylight?: boolean | null;
  lightOn?: boolean;
  triggerHasState?: boolean;
}) {
  const listeners: Listener[] = [];
  const stateMap = new Map<string, unknown>();
  const turnOnLights = vi.fn(() => [] as string[]);
  const turnOffLights = vi.fn(() => [] as string[]);

  let lightIsOn = opts.lightOn ?? false;
  const isAnyLightOn = vi.fn(() => lightIsOn);

  const ctx = {
    eventBus: {
      onType: (type: string, fn: (event: Record<string, unknown>) => void) => {
        listeners.push({ type, fn });
        return () => {
          const i = listeners.findIndex((l) => l.fn === fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
    },
    equipmentManager: {
      getByIdWithDetails: (id: string) => {
        if (id === "trigger-1") {
          return {
            id,
            name: "Gate",
            type: "gate",
            dataBindings: opts.triggerHasState === false ? [] : [{ alias: "state" }],
            orderBindings: [],
          };
        }
        if (id.startsWith("light-")) {
          return {
            id,
            name: `Light ${id}`,
            type: "light_onoff",
            dataBindings: [{ alias: "state" }],
            orderBindings: [{ alias: "state", enumValues: ["ON", "OFF"] }],
          };
        }
        return null;
      },
      getDataBindingsWithValues: vi.fn(() => []),
      executeOrder: vi.fn().mockResolvedValue(undefined),
    },
    zoneManager: {
      getById: (id: string) => (id === "zone-1" ? { id, name: "Maison" } : null),
    },
    zoneAggregator: {
      getByZoneId: (id: string) => (id === ROOT_ZONE_ID ? { isDaylight: opts.isDaylight ?? false } : null),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    state: {
      get: (k: string) => stateMap.get(k),
      set: (k: string, v: unknown) => {
        stateMap.set(k, v);
      },
      delete: (k: string) => {
        stateMap.delete(k);
      },
      clear: () => stateMap.clear(),
    },
    log: vi.fn(),
    helpers: {
      isAnyLightOn,
      turnOnLights: (ids: string[]) => {
        lightIsOn = true;
        return turnOnLights(ids);
      },
      turnOffLights: (ids: string[]) => {
        lightIsOn = false;
        return turnOffLights(ids);
      },
      parseDuration: (v: unknown) => {
        if (typeof v === "number") return v;
        if (typeof v !== "string") return 0;
        const m = v.match(/^(\d+)(ms|s|m|h)?$/);
        if (!m) return 0;
        const n = parseInt(m[1], 10);
        const u = m[2] ?? "ms";
        return u === "ms" ? n : u === "s" ? n * 1000 : u === "m" ? n * 60_000 : n * 3_600_000;
      },
      formatDuration: (ms: number) => `${ms}ms`,
    },
  };

  function emit(event: Record<string, unknown>) {
    for (const l of listeners) {
      if (l.type === event.type) l.fn(event);
    }
  }

  function setLightOn(on: boolean) {
    lightIsOn = on;
  }

  return { ctx, listeners, stateMap, turnOnLights, turnOffLights, emit, setLightOn };
}

const baseParams = {
  zone: "zone-1",
  trigger: "trigger-1",
  stateValue: "open",
  lights: ["light-1"],
  duration: "5m",
  nightOnly: true,
};

// ============================================================
// Tests
// ============================================================

describe("state-trigger-light", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T20:00:00Z"));
  });

  it("fires on transition into target value at night, lights off", () => {
    const recipe = createRecipe();
    const { ctx, turnOnLights, emit } = makeCtx({ isDaylight: false, lightOn: false });
    const inst = recipe.createInstance(baseParams, ctx);

    emit({ type: "equipment.data.changed", equipmentId: "trigger-1", alias: "state", value: "open", previous: "closed" });

    expect(turnOnLights).toHaveBeenCalledOnce();
    inst.stop();
  });

  it("ignores no-change event (previous === value)", () => {
    const recipe = createRecipe();
    const { ctx, turnOnLights, emit } = makeCtx({ isDaylight: false, lightOn: false });
    const inst = recipe.createInstance(baseParams, ctx);

    emit({ type: "equipment.data.changed", equipmentId: "trigger-1", alias: "state", value: "open", previous: "open" });

    expect(turnOnLights).not.toHaveBeenCalled();
    inst.stop();
  });

  it("ignores event with non-target value", () => {
    const recipe = createRecipe();
    const { ctx, turnOnLights, emit } = makeCtx({ isDaylight: false, lightOn: false });
    const inst = recipe.createInstance(baseParams, ctx);

    emit({ type: "equipment.data.changed", equipmentId: "trigger-1", alias: "state", value: "closed", previous: "open" });

    expect(turnOnLights).not.toHaveBeenCalled();
    inst.stop();
  });

  it("nightOnly=true + daytime → skipped", () => {
    const recipe = createRecipe();
    const { ctx, turnOnLights, emit } = makeCtx({ isDaylight: true, lightOn: false });
    const inst = recipe.createInstance(baseParams, ctx);

    emit({ type: "equipment.data.changed", equipmentId: "trigger-1", alias: "state", value: "open", previous: "closed" });

    expect(turnOnLights).not.toHaveBeenCalled();
    inst.stop();
  });

  it("nightOnly=true + isDaylight=null → treated as night, fires", () => {
    const recipe = createRecipe();
    const { ctx, turnOnLights, emit } = makeCtx({ isDaylight: null, lightOn: false });
    const inst = recipe.createInstance(baseParams, ctx);

    emit({ type: "equipment.data.changed", equipmentId: "trigger-1", alias: "state", value: "open", previous: "closed" });

    expect(turnOnLights).toHaveBeenCalledOnce();
    inst.stop();
  });

  it("nightOnly=false + daytime → fires", () => {
    const recipe = createRecipe();
    const { ctx, turnOnLights, emit } = makeCtx({ isDaylight: true, lightOn: false });
    const inst = recipe.createInstance({ ...baseParams, nightOnly: false }, ctx);

    emit({ type: "equipment.data.changed", equipmentId: "trigger-1", alias: "state", value: "open", previous: "closed" });

    expect(turnOnLights).toHaveBeenCalledOnce();
    inst.stop();
  });

  it("light already on at trigger time → skipped (no off-timer armed)", () => {
    const recipe = createRecipe();
    const { ctx, turnOnLights, turnOffLights, emit, stateMap } = makeCtx({ isDaylight: false, lightOn: true });
    const inst = recipe.createInstance(baseParams, ctx);

    emit({ type: "equipment.data.changed", equipmentId: "trigger-1", alias: "state", value: "open", previous: "closed" });
    expect(turnOnLights).not.toHaveBeenCalled();
    expect(stateMap.has("expiresAt")).toBe(false);

    // Advance way past the duration — no turn-off happens because no timer was armed
    vi.advanceTimersByTime(600_000);
    expect(turnOffLights).not.toHaveBeenCalled();

    inst.stop();
  });

  it("offTimer fires after duration — lights off, state cleared", () => {
    const recipe = createRecipe();
    const { ctx, turnOffLights, emit, stateMap } = makeCtx({ isDaylight: false, lightOn: false });
    const inst = recipe.createInstance(baseParams, ctx);

    emit({ type: "equipment.data.changed", equipmentId: "trigger-1", alias: "state", value: "open", previous: "closed" });
    expect(stateMap.has("expiresAt")).toBe(true);

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(turnOffLights).toHaveBeenCalledOnce();
    expect(stateMap.has("expiresAt")).toBe(false);

    inst.stop();
  });

  it("manual light-off during timer cancels the off-timer", () => {
    const recipe = createRecipe();
    const { ctx, turnOffLights, emit, stateMap, setLightOn } = makeCtx({ isDaylight: false, lightOn: false });
    const inst = recipe.createInstance(baseParams, ctx);

    emit({ type: "equipment.data.changed", equipmentId: "trigger-1", alias: "state", value: "open", previous: "closed" });
    expect(stateMap.has("expiresAt")).toBe(true);

    // Move past grace period before simulating manual off
    vi.advanceTimersByTime(3000);
    setLightOn(false);
    emit({ type: "equipment.data.changed", equipmentId: "light-1", alias: "state", value: "OFF", previous: "ON" });

    expect(stateMap.has("expiresAt")).toBe(false);

    // Advance past original deadline — turn-off is NOT called by the timer
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(turnOffLights).not.toHaveBeenCalled();

    inst.stop();
  });

  it("restart with persisted expiresAt in the future arms timer for remainder", () => {
    const recipe = createRecipe();
    const { ctx, turnOffLights, stateMap } = makeCtx({ isDaylight: false, lightOn: true });
    stateMap.set("expiresAt", new Date(Date.now() + 60_000).toISOString());

    const inst = recipe.createInstance(baseParams, ctx);
    expect(stateMap.has("expiresAt")).toBe(true);

    vi.advanceTimersByTime(60_000);
    expect(turnOffLights).toHaveBeenCalledOnce();

    inst.stop();
  });

  it("restart with persisted expiresAt in the past + lights on → turn off once", () => {
    const recipe = createRecipe();
    const { ctx, turnOffLights, stateMap } = makeCtx({ isDaylight: false, lightOn: true });
    stateMap.set("expiresAt", new Date(Date.now() - 1000).toISOString());

    const inst = recipe.createInstance(baseParams, ctx);

    expect(turnOffLights).toHaveBeenCalledOnce();
    expect(stateMap.has("expiresAt")).toBe(false);

    inst.stop();
  });

  it("restart with persisted expiresAt in the past + lights already off → just clears state", () => {
    const recipe = createRecipe();
    const { ctx, turnOffLights, stateMap } = makeCtx({ isDaylight: false, lightOn: false });
    stateMap.set("expiresAt", new Date(Date.now() - 1000).toISOString());

    const inst = recipe.createInstance(baseParams, ctx);

    expect(turnOffLights).not.toHaveBeenCalled();
    expect(stateMap.has("expiresAt")).toBe(false);

    inst.stop();
  });

  it("re-trigger during running timer is a no-op (already on, timer untouched)", () => {
    const recipe = createRecipe();
    const { ctx, turnOnLights, turnOffLights, emit } = makeCtx({ isDaylight: false, lightOn: false });
    const inst = recipe.createInstance(baseParams, ctx);

    emit({ type: "equipment.data.changed", equipmentId: "trigger-1", alias: "state", value: "open", previous: "closed" });
    expect(turnOnLights).toHaveBeenCalledOnce();

    // Light is now on. A second trigger event arrives.
    emit({ type: "equipment.data.changed", equipmentId: "trigger-1", alias: "state", value: "open", previous: "closed" });
    expect(turnOnLights).toHaveBeenCalledOnce(); // still 1

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(turnOffLights).toHaveBeenCalledOnce();

    inst.stop();
  });

  it("validate: trigger ∈ lights throws", () => {
    const recipe = createRecipe();
    const { ctx } = makeCtx({});
    expect(() =>
      recipe.validate(
        { ...baseParams, lights: ["trigger-1"] },
        ctx,
      ),
    ).toThrow();
  });

  it("validate: trigger has no `state` binding throws", () => {
    const recipe = createRecipe();
    const { ctx } = makeCtx({ triggerHasState: false });
    expect(() => recipe.validate(baseParams, ctx)).toThrow(/no "state" data binding/);
  });

  it("validate: empty stateValue throws", () => {
    const recipe = createRecipe();
    const { ctx } = makeCtx({});
    expect(() => recipe.validate({ ...baseParams, stateValue: "  " }, ctx)).toThrow();
  });

  it("validate: empty lights throws", () => {
    const recipe = createRecipe();
    const { ctx } = makeCtx({});
    expect(() => recipe.validate({ ...baseParams, lights: [] }, ctx)).toThrow();
  });
});
