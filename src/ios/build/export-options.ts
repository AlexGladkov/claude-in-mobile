/**
 * Generate ExportOptions.plist for `xcodebuild -exportArchive`.
 *
 * Fixed policy: automatic signing + generateAppStoreInformation — the pipeline
 * targets App Store Connect / TestFlight uploads exclusively.
 */

import { randomBytes } from "crypto";
import { writeFile } from "fs/promises";
import { join } from "path";
import { validatePath, validatePathContainment } from "../../utils/sanitize.js";

export interface ExportOptionsConfig {
  /** Only App Store Connect is supported by this pipeline. */
  method?: "app-store-connect";
  /** "upload" sends straight to ASC; "export" leaves the .ipa on disk. */
  destination?: "upload" | "export";
  /** Let Xcode bump CFBundleVersion on collision (default: true). */
  manageVersion?: boolean;
}

const PLIST_BOOL = (value: boolean): string => (value ? "<true/>" : "<false/>");

/** Deterministic plist body — exported separately so tests can snapshot it. */
export function renderExportOptionsPlist(config: ExportOptionsConfig = {}): string {
  const method = config.method ?? "app-store-connect";
  const destination = config.destination ?? "upload";
  const manageVersion = config.manageVersion ?? true;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>method</key>
\t<string>${method}</string>
\t<key>destination</key>
\t<string>${destination}</string>
\t<key>signingStyle</key>
\t<string>automatic</string>
\t<key>generateAppStoreInformation</key>
\t${PLIST_BOOL(true)}
\t<key>manageAppVersionAndBuildNumber</key>
\t${PLIST_BOOL(manageVersion)}
</dict>
</plist>
`;
}

/**
 * Write the plist to a uniquely-named temp file inside `dir` and return its
 * absolute path. Containment is validated so a hostile `dir` cannot place the
 * file outside itself.
 */
export async function writeExportOptionsPlist(
  dir: string,
  config: ExportOptionsConfig = {},
): Promise<string> {
  validatePath(dir, "export options directory");
  const fileName = `ExportOptions-${randomBytes(4).toString("hex")}.plist`;
  const filePath = join(dir, fileName);
  validatePathContainment(filePath, dir);
  await writeFile(filePath, renderExportOptionsPlist(config), "utf-8");
  return filePath;
}
