import { Worker } from "node:worker_threads";

import { ValidationError } from "../errors.js";

const MAX_PATTERN_CHARS = 512;
const MAX_LINE_CHARS = 64 * 1024;
const MATCH_TIMEOUT_MS = 100;

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const regex = new RegExp(workerData.pattern, workerData.flags);
parentPort.on("message", ({ id, lines }) => {
  let index = -1;
  for (let i = 0; i < lines.length; i += 1) {
    regex.lastIndex = 0;
    if (regex.test(lines[i])) { index = i; break; }
  }
  parentPort.postMessage({ id, index });
});
`;

export class BoundedRegexMatcher {
  private readonly worker: Worker;
  private nextId = 1;
  private closed = false;

  constructor(pattern: string, caseSensitive: boolean) {
    if (pattern.length > MAX_PATTERN_CHARS) {
      throw new ValidationError(`Regex pattern exceeds ${MAX_PATTERN_CHARS} characters.`);
    }
    const flags = caseSensitive ? "" : "i";
    try {
      new RegExp(pattern, flags);
    } catch (error) {
      throw new ValidationError(
        `Invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { pattern, flags },
    });
  }

  findMatch(lines: readonly string[]): Promise<number> {
    if (this.closed) throw new Error("Regex matcher is closed.");
    const id = this.nextId++;
    const boundedLines = lines.map((line) => line.slice(0, MAX_LINE_CHARS));
    return new Promise<number>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timeout);
        this.worker.off("message", onMessage);
        this.worker.off("error", onError);
      };
      const onMessage = (message: { id: number; index: number }): void => {
        if (message.id !== id) return;
        cleanup();
        resolve(message.index);
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const timeout = setTimeout(() => {
        cleanup();
        this.closed = true;
        void this.worker.terminate();
        reject(new ValidationError(
          `Regex evaluation exceeded ${MATCH_TIMEOUT_MS}ms and was terminated. Use a simpler pattern.`,
        ));
      }, MATCH_TIMEOUT_MS);
      this.worker.on("message", onMessage);
      this.worker.once("error", onError);
      this.worker.postMessage({ id, lines: boundedLines });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.worker.terminate();
  }
}
