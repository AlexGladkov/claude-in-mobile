import { MobileError } from "./base.js";

export class SyncGroupNotFoundError extends MobileError {
  constructor(name: string) {
    super(
      `Sync group "${name}" not found. Use sync(action:'list') to see active groups.`,
      "SYNC_GROUP_NOT_FOUND"
    );
  }
}

export class SyncGroupExistsError extends MobileError {
  constructor(name: string) {
    super(
      `Sync group "${name}" already exists. Use sync(action:'destroy') first or choose a different name.`,
      "SYNC_GROUP_EXISTS"
    );
  }
}

export class SyncBarrierTimeoutError extends MobileError {
  constructor(barrierName: string, timeoutMs: number) {
    super(
      `Barrier "${barrierName}" timed out after ${timeoutMs}ms. Not all roles reached the barrier in time.`,
      "SYNC_BARRIER_TIMEOUT"
    );
  }
}

export class SyncRoleNotFoundError extends MobileError {
  constructor(role: string, group: string) {
    super(
      `Role "${role}" not found in sync group "${group}". Use sync(action:'status') to see defined roles.`,
      "SYNC_ROLE_NOT_FOUND"
    );
  }
}
