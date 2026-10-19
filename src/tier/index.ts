export * from './domain.ts';
import {
  SERVICE_TIER_PROVIDER_DEFINITIONS, isRecord, isServiceTierProvider,
  applyServiceTierToPayload, toggleFastServiceTier,
  type ServiceTierSettings, type ServiceTierModel, type ServiceTierProvider, type ServiceTierSelection,
} from './domain.ts';

export interface TierSessionState { version: 1; overrides: ServiceTierSettings }
/** Strict settings validation, without reading or writing Pi/user configuration. */
export function parseTierSettings(value: unknown, allowOff = false): ServiceTierSettings {
  if (!isRecord(value)) throw new TypeError('Service tier settings must be an object');
  const result: Partial<Record<ServiceTierProvider, ServiceTierSelection>> = {};
  for (const [provider, selection] of Object.entries(value)) {
    if (!isServiceTierProvider(provider) ||
        !(allowOff && selection === '' || SERVICE_TIER_PROVIDER_DEFINITIONS[provider].tiers.some(t => t.name === selection))) {
      throw new TypeError('Invalid provider service tier selection');
    }
    result[provider] = selection as ServiceTierSelection;
  }
  return result;
}
/** Session overrides match Pi: missing inherits, empty string explicitly turns off. */
export class ServiceTierSettingsHelper {
  private defaults: ServiceTierSettings;
  private readonly sessions = new Map<string, ServiceTierSettings>();
  constructor(defaults: unknown = {}) { this.defaults = parseTierSettings(defaults); }
  setDefaults(defaults: unknown): void { this.defaults = parseTierSettings(defaults); }
  effective(sessionId?: string): ServiceTierSettings {
    return { ...this.defaults, ...(sessionId === undefined ? {} : this.sessions.get(sessionId)) };
  }
  snapshot(sessionId: string): TierSessionState {
    return { version: 1, overrides: { ...this.sessions.get(sessionId) } };
  }
  restore(sessionId: string, state: unknown): void {
    if (!isRecord(state) || state.version !== 1) throw new TypeError('Invalid tier session state');
    this.sessions.set(sessionId, parseTierSettings(state.overrides, true));
  }
  setOverride(sessionId: string, provider: ServiceTierProvider, selection: ServiceTierSelection | undefined): TierSessionState {
    const next = { ...this.sessions.get(sessionId) };
    if (selection === undefined) delete next[provider];
    else Object.assign(next, parseTierSettings({ [provider]: selection }, true));
    this.sessions.set(sessionId, next);
    return this.snapshot(sessionId);
  }
  toggleFast(sessionId: string, model: ServiceTierModel): TierSessionState | undefined {
    const toggle = toggleFastServiceTier(this.effective(sessionId), model);
    return toggle && this.setOverride(sessionId, toggle.provider, toggle.serviceTier);
  }
  clear(sessionId: string): void { this.sessions.delete(sessionId); }
  /** Composes after an earlier payload hook; omitted selection leaves original fields unchanged. */
  requestHook(sessionId?: string, previous?: (payload: unknown, model: ServiceTierModel) => unknown | Promise<unknown>) {
    return async (payload: unknown, model: ServiceTierModel): Promise<unknown> => {
      const replacement = await previous?.(payload, model);
      const current = replacement === undefined ? payload : replacement;
      return applyServiceTierToPayload(current, this.effective(sessionId), model) ?? current;
    };
  }
}
/** A policy limit is a cap, NEVER an invented increase in model capability. */
export function effectiveContextCapacity(realCapacity: number, configuredCap?: number | null): number {
  if (!Number.isSafeInteger(realCapacity) || realCapacity <= 0) throw new TypeError('Invalid real model capacity');
  if (configuredCap === undefined || configuredCap === null) return realCapacity;
  if (!Number.isSafeInteger(configuredCap) || configuredCap <= 0) throw new TypeError('Invalid context capacity cap');
  return Math.min(realCapacity, configuredCap);
}
