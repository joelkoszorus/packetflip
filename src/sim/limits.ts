/**
 * Hard safety caps. These keep a hostile or accidental topology (loops, storms,
 * huge imports) from freezing the browser. Exceeding one produces a visible
 * drop reason or a validation error, never a hang.
 */
export const LIMITS = {
  maxDevices: 300,
  maxLinks: 1200,
  maxPortsPerDevice: 48,
  maxNameLength: 32,
  maxFramesInFlight: 4000,
  maxEventsPerAdvance: 50_000,
  maxEventsPerRun: 500_000,
  maxL2Hops: 32,
  defaultTtl: 64,
  maxArpPending: 16,
  maxQueuePerLink: 48,
  maxStaticRoutes: 64,
  maxVlans: 64,
  maxAclEntries: 64,
  maxSaveBytes: 512 * 1024,
  maxTraceEntries: 2000,
} as const;
