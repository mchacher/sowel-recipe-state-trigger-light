// ============================================================
// State-Triggered Light Recipe — external package
// ============================================================
//
// Turns lights on for a fixed duration when a watched equipment's
// `state` alias changes to a configured target value. Optionally only
// at night (uses the root zone's `isDaylight` aggregation).

// --- Minimal RecipeContext shape (injected by Sowel core at runtime) ---

interface RecipeContext {
  eventBus: {
    onType(type: string, handler: (event: Record<string, unknown>) => void): () => void;
  };
  equipmentManager: {
    getByIdWithDetails(id: string): {
      id: string;
      name: string;
      type: string;
      zoneId?: string;
      dataBindings: Array<{ alias: string }>;
      orderBindings: Array<{ alias: string; enumValues?: string[] }>;
    } | null;
    getDataBindingsWithValues(id: string): Array<{ alias: string; category?: string; value: unknown }>;
    executeOrder(equipmentId: string, alias: string, value: unknown): Promise<void>;
  };
  zoneManager: {
    getById(id: string): { id: string; name: string } | null;
  };
  zoneAggregator: {
    getByZoneId(zoneId: string): {
      isDaylight?: boolean | null;
    } | null;
  };
  logger: {
    info(obj: Record<string, unknown>, msg?: string): void;
    warn(obj: Record<string, unknown>, msg?: string): void;
    error(obj: Record<string, unknown>, msg?: string): void;
    debug(obj: Record<string, unknown>, msg?: string): void;
  };
  state: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    delete(key: string): void;
    clear(): void;
  };
  log: (message: string, level?: "info" | "warn" | "error") => void;
  helpers: {
    isAnyLightOn(lightIds: string[], ctx: RecipeContext): boolean;
    turnOnLights(lightIds: string[], ctx: RecipeContext): string[];
    turnOffLights(lightIds: string[], ctx: RecipeContext): string[];
    parseDuration(value: unknown): number;
    formatDuration(ms: number): string;
  };
}

interface RecipeSlotDef {
  id: string;
  name: string;
  description: string;
  type: "zone" | "equipment" | "number" | "duration" | "time" | "boolean" | "text" | "data-key";
  required: boolean;
  list?: boolean;
  defaultValue?: unknown;
  constraints?: {
    equipmentType?: string | string[];
    min?: number;
    max?: number;
  };
  group?: string;
}

interface RecipeLangPack {
  name: string;
  description: string;
  slots?: Record<string, { name: string; description: string }>;
  groups?: Record<string, string>;
}

interface RecipeDefinition {
  id: string;
  name: string;
  description: string;
  slots: RecipeSlotDef[];
  actions?: unknown[];
  i18n?: Record<string, RecipeLangPack>;
  validate(params: Record<string, unknown>, ctx: RecipeContext): void;
  createInstance(
    params: Record<string, unknown>,
    ctx: RecipeContext,
  ): { stop(): void; onAction?(action: string, payload?: Record<string, unknown>): void };
}

// ============================================================
// Constants
// ============================================================

/** Well-known ID for the root zone "Maison". */
const ROOT_ZONE_ID = "00000000-0000-0000-0000-000000000001";

/** Ignore light off-echoes for this many ms after we send an OFF order. */
const TURN_OFF_GRACE_MS = 2000;

// ============================================================
// Helpers
// ============================================================

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((id): id is string => typeof id === "string");
  }
  if (typeof value === "string" && value.length > 0) {
    return value.split(",").filter(Boolean);
  }
  return [];
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

// ============================================================
// Recipe Definition
// ============================================================

export function createRecipe(): RecipeDefinition {
  return {
    id: "state-trigger-light",
    name: "State-Triggered Light",
    description:
      "Turn lights on for a fixed duration when a watched equipment's state changes to a configured target value (e.g. gate → open at night).",

    slots: [
      {
        id: "zone",
        name: "Zone",
        description: "Zone where the lights live",
        type: "zone",
        required: true,
      },
      {
        id: "trigger",
        name: "Trigger equipment",
        description: "Equipment whose `state` alias is watched",
        type: "equipment",
        required: true,
      },
      {
        id: "stateValue",
        name: "Target state value",
        description:
          "Recipe fires when the equipment's state changes to this exact value (e.g. 'open', 'ON', 'true')",
        type: "text",
        required: true,
      },
      {
        id: "lights",
        name: "Lights",
        description: "Lights to turn on",
        type: "equipment",
        required: true,
        list: true,
        constraints: { equipmentType: "light_onoff" },
      },
      {
        id: "duration",
        name: "Duration",
        description: "How long the lights stay on after a trigger",
        type: "duration",
        required: true,
        defaultValue: "5m",
      },
      {
        id: "nightOnly",
        name: "Night only",
        description: "Only fire when it's dark outside (uses sunrise/sunset)",
        type: "boolean",
        required: false,
        defaultValue: true,
      },
    ],

    i18n: {
      fr: {
        name: "Lumière sur changement d'état",
        description:
          "Allume des lumières pour une durée fixe quand l'état d'un équipement passe à une valeur cible (ex: portail ouvert la nuit).",
        slots: {
          zone: { name: "Zone", description: "Zone des lumières" },
          trigger: {
            name: "Équipement déclencheur",
            description: "Équipement dont l'état est surveillé (alias 'state')",
          },
          stateValue: {
            name: "Valeur cible",
            description:
              "La recette se déclenche quand l'état devient exactement cette valeur (ex: 'open', 'ON')",
          },
          lights: { name: "Lumières", description: "Lumières à allumer" },
          duration: { name: "Durée", description: "Durée d'allumage après le déclenchement" },
          nightOnly: {
            name: "Seulement la nuit",
            description: "Ne se déclenche que si le soleil est couché",
          },
        },
      },
    },

    validate(params: Record<string, unknown>, ctx: RecipeContext): void {
      const zoneId = params.zone;
      if (typeof zoneId !== "string" || !zoneId) {
        throw new Error("Zone is required");
      }
      if (!ctx.zoneManager.getById(zoneId)) {
        throw new Error("Zone not found");
      }

      const triggerId = params.trigger;
      if (typeof triggerId !== "string" || !triggerId) {
        throw new Error("Trigger equipment is required");
      }
      const trigger = ctx.equipmentManager.getByIdWithDetails(triggerId);
      if (!trigger) {
        throw new Error("Trigger equipment not found");
      }
      const hasStateBinding = trigger.dataBindings.some((b) => b.alias === "state");
      if (!hasStateBinding) {
        throw new Error(`Trigger "${trigger.name}" has no "state" data binding`);
      }

      const stateValue = params.stateValue;
      if (typeof stateValue !== "string" || stateValue.trim() === "") {
        throw new Error("Target state value is required");
      }

      const lightIds = normalizeStringArray(params.lights);
      if (lightIds.length === 0) {
        throw new Error("At least one light is required");
      }
      for (const id of lightIds) {
        const light = ctx.equipmentManager.getByIdWithDetails(id);
        if (!light) throw new Error(`Light ${id} not found`);
        if (light.type !== "light_onoff") {
          throw new Error(`"${light.name}" is not a light_onoff equipment`);
        }
      }
      if (lightIds.includes(triggerId)) {
        throw new Error("Trigger equipment cannot also be a light controlled by this recipe");
      }

      const durationValue = params.duration ?? "5m";
      const ms = ctx.helpers.parseDuration(durationValue);
      if (!Number.isFinite(ms) || ms <= 0) {
        throw new Error("Duration must be > 0");
      }
    },

    createInstance(params: Record<string, unknown>, ctx: RecipeContext) {
      const triggerId = params.trigger as string;
      const stateValue = (params.stateValue as string).trim();
      const lightIds = normalizeStringArray(params.lights);
      const durationMs = ctx.helpers.parseDuration(params.duration ?? "5m");
      const nightOnly = params.nightOnly !== false;

      let offTimer: ReturnType<typeof setTimeout> | null = null;
      let turnOffGraceUntil = 0;
      let stopped = false;
      const unsubs: (() => void)[] = [];

      // --- Helpers ---

      function isNight(): boolean {
        const root = ctx.zoneAggregator.getByZoneId(ROOT_ZONE_ID);
        // null/undefined isDaylight (no coords configured) → treat as night.
        return root?.isDaylight !== true;
      }

      function clearExpiresAt(): void {
        ctx.state.delete("expiresAt");
      }

      function setExpiresAt(ms: number): void {
        ctx.state.set("expiresAt", new Date(Date.now() + ms).toISOString());
      }

      function cancelOffTimer(): void {
        if (offTimer) {
          clearTimeout(offTimer);
          offTimer = null;
        }
      }

      function turnOff(reason: string): void {
        const errors = ctx.helpers.turnOffLights(lightIds, ctx);
        if (errors.length > 0) {
          ctx.log(`Error turning off some lights: ${errors.join("; ")}`, "error");
        }
        ctx.log(reason);
        turnOffGraceUntil = Date.now() + TURN_OFF_GRACE_MS;
        cancelOffTimer();
        clearExpiresAt();
      }

      function armOffTimer(ms: number): void {
        cancelOffTimer();
        offTimer = setTimeout(() => {
          offTimer = null;
          turnOff(`State trigger off after ${ctx.helpers.formatDuration(durationMs)}`);
        }, ms);
        setExpiresAt(ms);
      }

      function fire(): void {
        if (stopped) return;
        if (nightOnly && !isNight()) {
          ctx.log("State trigger ignored — daytime");
          return;
        }
        if (ctx.helpers.isAnyLightOn(lightIds, ctx)) {
          ctx.log("State trigger ignored — at least one light already on");
          return;
        }
        const errors = ctx.helpers.turnOnLights(lightIds, ctx);
        if (errors.length > 0) {
          ctx.log(`Error turning on some lights: ${errors.join("; ")}`, "error");
        }
        ctx.log(
          `State trigger fired — ${lightIds.length} light(s) on for ${ctx.helpers.formatDuration(durationMs)}`,
        );
        armOffTimer(durationMs);
      }

      // --- Restore from persisted state across Sowel restart ---

      const persistedExpiresAt = ctx.state.get("expiresAt");
      if (typeof persistedExpiresAt === "string") {
        const expiresMs = Date.parse(persistedExpiresAt);
        if (Number.isFinite(expiresMs)) {
          const remaining = expiresMs - Date.now();
          if (remaining > 0) {
            armOffTimer(remaining);
            ctx.log(
              `Resumed off-timer with ${ctx.helpers.formatDuration(remaining)} remaining`,
            );
          } else if (ctx.helpers.isAnyLightOn(lightIds, ctx)) {
            turnOff("Resumed state trigger past deadline — lights off");
          } else {
            clearExpiresAt();
          }
        } else {
          clearExpiresAt();
        }
      }

      // --- Trigger subscription ---

      const unsubTrigger = ctx.eventBus.onType("equipment.data.changed", (event) => {
        try {
          if (stopped) return;
          if (event.equipmentId !== triggerId) return;
          if (event.alias !== "state") return;
          const value = asString(event.value);
          const previous = asString(event.previous);
          if (value !== stateValue) return;
          if (previous === stateValue) return; // not a transition
          fire();
        } catch (err) {
          ctx.logger.error({ err }, "Error in state trigger handler");
        }
      });
      unsubs.push(unsubTrigger);

      // --- Light off detection (manual or external) ---
      // If the user turns off the lights while the timer is running,
      // cancel our off-timer so we don't hammer them again at expiry.
      const unsubLight = ctx.eventBus.onType("equipment.data.changed", (event) => {
        try {
          if (stopped) return;
          if (!lightIds.includes(event.equipmentId as string)) return;
          if (event.alias !== "state") return;
          const value = event.value;
          const lightOn = value === true || value === "ON" || value === "on";
          if (lightOn) return;
          if (Date.now() < turnOffGraceUntil) return; // ignore our own echo
          if (offTimer && !ctx.helpers.isAnyLightOn(lightIds, ctx)) {
            cancelOffTimer();
            clearExpiresAt();
            ctx.log("Lights turned off externally — timer cancelled");
          }
        } catch (err) {
          ctx.logger.error({ err }, "Error in light off-detect handler");
        }
      });
      unsubs.push(unsubLight);

      return {
        stop() {
          stopped = true;
          cancelOffTimer();
          for (const u of unsubs) u();
          unsubs.length = 0;
        },
      };
    },
  };
}
