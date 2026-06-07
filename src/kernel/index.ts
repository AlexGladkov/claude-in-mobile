/**
 * claude-in-mobile microkernel.
 *
 * Kernel composition: registry + lifecycle + event bus + resolver + loader +
 * guard. Knows nothing about concrete platform plugins — see ADR 0001.
 */

export { InMemoryEventBus } from "./eventbus.js";
export {
  InMemoryRegistry,
  type PluginRegistry,
  type RegistryEntry,
} from "./registry.js";
export {
  DEFAULT_DISPOSE_TIMEOUT_MS,
  DEFAULT_INIT_TIMEOUT_MS,
  LifecycleOrchestrator,
  type LifecycleDeps,
} from "./lifecycle.js";
export {
  CapabilityResolver,
  type ResolveQuery,
} from "./resolver.js";
export {
  hasAll,
  requireAll,
  requireCapability,
} from "./guard.js";
export { BuiltinPluginLoader, type BuiltinLoaderDeps } from "./loader.js";
