import { WDAClient } from "./wda-client.js";
export declare class WDAManager {
    private instances;
    private clients;
    /** Deduplicates parallel launches for the same device */
    private launchPromises;
    private readonly startupTimeout;
    private readonly buildTimeout;
    ensureWDAReady(deviceId: string): Promise<WDAClient>;
    private doLaunch;
    private discoverWDA;
    private buildWDAIfNeeded;
    private launchWDA;
    private checkHealth;
    private findFreePort;
    cleanup(): void;
}
//# sourceMappingURL=wda-manager.d.ts.map