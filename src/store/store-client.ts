export interface UploadResult {
  versionId: string;
}

export interface StoreClient {
  upload(packageName: string, filePath: string): Promise<UploadResult>;
  setReleaseNotes(packageName: string, language: string, text: string): Promise<void>;
  submit(packageName: string, options?: { rollout?: number }): Promise<void>;
  getReleases(packageName: string): Promise<string>;
  discard?(packageName: string): Promise<void>;
}
