import { setTimeout as delay } from "node:timers/promises";

export const sleep = (ms: number): Promise<void> => delay(ms);
