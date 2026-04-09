import type { Device } from "../device-manager.js";

export interface SonicConnectionInfo {
  agentHost: string;
  agentPort: number;
  key: string;
  token: string;
}

interface SonicServerDevice {
  udId: string;
  nickName?: string;
  platform: number;
  status: string;
}

export class SonicDeviceSource {
  private devices: Device[] = [];
  private conn: SonicConnectionInfo | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly agentId: number,
    private readonly token: string,
    private readonly pollInterval: number = 30_000,
  ) {}

  async start(): Promise<void> {
    await this.fetchOnce();
    this.timer = setInterval(() => this.fetchDevicesOnly(), this.pollInterval);
  }

  async fetchOnce(): Promise<void> {
    await this.fetchAgentInfo();
    await this.fetchDevicesOnly();
  }

  async fetchDevicesOnly(): Promise<void> {
    try {
      const list = await this.get<SonicServerDevice[]>(
        "/server/api/controller/devices/listByAgentId",
        { agentId: this.agentId },
      );
      this.devices = list.map(d => this.buildDevice(d));
    } catch {
      // Preserve cache
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  listDevices(): Device[] {
    return this.devices;
  }

  getConnectionInfo(): SonicConnectionInfo {
    if (!this.conn) throw new Error("SonicDeviceSource not initialized — call fetchOnce() first");
    return this.conn;
  }

  private async fetchAgentInfo(): Promise<void> {
    const data = await this.get<{ host: string; port: number; agentKey: string }>(
      "/server/api/controller/agents",
      { id: this.agentId },
    );
    if (!data.host || !data.port || !data.agentKey) {
      throw new Error(`Sonic agent info incomplete: ${JSON.stringify(data)}`);
    }
    this.conn = { agentHost: data.host, agentPort: data.port, key: data.agentKey, token: this.token };
  }

  private buildDevice(raw: SonicServerDevice): Device {
    return {
      id: raw.udId,
      name: raw.nickName ?? raw.udId,
      platform: raw.platform === 2 ? "ios" : "android",
      state: raw.status,
      isSimulator: false,
    };
  }

  private async get<T>(path: string, params: Record<string, unknown>): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const res = await fetch(url.toString(), { headers: { SonicToken: this.token } });
    if (!res.ok) throw new Error(`Sonic API ${path} failed: HTTP ${res.status}`);
    const json = await res.json() as { code: number; message?: string; data: T };
    if (json.code !== 2000) throw new Error(`Sonic API ${path} error: ${json.message}`);
    return json.data;
  }
}
