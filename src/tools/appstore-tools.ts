/**
 * App Store Connect / TestFlight tools (provider "apple" in the store meta).
 *
 * Pipeline: appstore_build -> appstore_upload -> appstore_get_releases (poll) ->
 *           appstore_set_notes -> appstore_promote (-> appstore_submit).
 *
 * SECURITY: auth is resolved from env ONLY (getAscAuthFromEnv) — key material
 * never enters tool arguments or results. Every LLM-supplied argument is
 * validated before it can reach xcodebuild/altool argv or an API URL.
 */

import { join } from "path";
import type { ToolDefinition } from "./registry.js";
import { defineTool, z } from "./define-tool.js";
import {
  AppStoreConnectClient,
  getAscAuthFromEnv,
  type AscBuild,
} from "../store/app-store-connect.js";
import {
  detectIosProject,
  listSchemes,
  pickReleaseScheme,
  writeExportOptionsPlist,
  archiveApp,
  exportArchive,
  buildFlutterIpa,
  uploadIpa,
  type AscApiAuth,
} from "../ios/build/index.js";
import {
  validateBundleId,
  validatePath,
  validatePathContainment,
  validateVersionString,
  validateXcodeScheme,
} from "../utils/sanitize.js";
import { AscKeyMissingError, MobileError, ValidationError } from "../errors.js";
import { createLazySingleton } from "../utils/lazy.js";
import { textResult } from "../utils/tool-result.js";

const client = createLazySingleton(() => new AppStoreConnectClient());

// ── validation helpers ────────────────────────────────────────────────────────

/** ASC resource IDs are UUID-ish; whitelist before embedding in API paths. */
const ASC_RESOURCE_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

function validateAscResourceId(id: string, label: string): void {
  if (!ASC_RESOURCE_ID_RE.test(id)) {
    throw new ValidationError(`Invalid ${label}: "${id}". Expected an App Store Connect resource ID.`);
  }
}

const LOCALE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

function validateLocale(locale: string): void {
  if (!LOCALE_RE.test(locale)) {
    throw new ValidationError(`Invalid locale: "${locale}". Expected BCP-47 (e.g. en-US, ru-RU).`);
  }
}

/** TestFlight "What to Test" hard limit. */
const WHATS_NEW_MAX_CHARS = 4000;

const LATEST_BUILD_LOOKUP_LIMIT = 10;

// ── shared resolution helpers ────────────────────────────────────────────────

/** xcodebuild needs the .p8 as a FILE — inline ASC_PRIVATE_KEY is not enough. */
function requireBuildAuth(): AscApiAuth {
  const auth = getAscAuthFromEnv();
  if (!auth.keyPath) {
    throw new AscKeyMissingError();
  }
  return { keyId: auth.keyId, issuerId: auth.issuerId, keyPath: auth.keyPath };
}

/** Resolves an explicit buildId, or the newest VALID (processed) build. */
async function resolveBuild(
  bundleId: string,
  buildId?: string,
): Promise<{ appId: string; buildId: string; version?: string }> {
  const app = await client().findApp(bundleId);
  if (buildId) {
    validateAscResourceId(buildId, "buildId");
    return { appId: app.id, buildId };
  }
  const builds = await client().getBuilds(app.id, { limit: LATEST_BUILD_LOOKUP_LIMIT });
  const valid = builds.find((b) => b.processingState === "VALID");
  if (!valid) {
    const states = builds.map((b) => `${b.version}: ${b.processingState}`).join(", ") || "no builds found";
    throw new MobileError(
      `No VALID (processed) build found for ${bundleId} (${states}). ` +
        "Wait for processing to finish — check with appstore_get_releases — then retry.",
      "TESTFLIGHT_NO_VALID_BUILD",
    );
  }
  return { appId: app.id, buildId: valid.id, version: valid.version };
}

function renderBuildsTable(builds: AscBuild[]): string {
  const header = `${"VERSION".padEnd(12)} ${"STATE".padEnd(22)} UPLOADED`;
  const rows = builds.map(
    (b) => `${b.version.padEnd(12)} ${b.processingState.padEnd(22)} ${b.uploadedDate || "-"}`,
  );
  return [header, ...rows].join("\n");
}

// ── tools ─────────────────────────────────────────────────────────────────────

export const appStoreTools: ToolDefinition[] = [
  defineTool({
    name: "appstore_build",
    description:
      "Build a signed .ipa for TestFlight (auto-detects Flutter/React Native/KMP/Xcode projects). " +
      "Requires ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_FILE env for automatic signing.",
    schema: z.object({
      projectPath: z.string().describe("Absolute path to the project root directory"),
      scheme: z.string().optional().describe("Xcode scheme (default: auto-pick Release scheme)"),
      configuration: z.string().optional().describe("Build configuration (default: Release)"),
    }),
    handler: async (args) => {
      validatePath(args.projectPath, "projectPath");
      if (args.scheme !== undefined) validateXcodeScheme(args.scheme);
      if (args.configuration !== undefined) validateXcodeScheme(args.configuration);

      const started = Date.now();
      const info = await detectIosProject(args.projectPath);

      if (info.kind === "flutter") {
        const { ipaPath } = await buildFlutterIpa(args.projectPath);
        const duration = ((Date.now() - started) / 1000).toFixed(1);
        return textResult(
          `IPA built (flutter): ${ipaPath}\nDuration: ${duration}s\n` +
            `Next: appstore_upload {"ipaPath": "${ipaPath}"}`,
        );
      }

      const auth = requireBuildAuth();
      const schemes = await listSchemes(info);
      let scheme: string;
      if (args.scheme) {
        if (schemes.length > 0 && !schemes.includes(args.scheme)) {
          throw new MobileError(
            `Scheme "${args.scheme}" not found. Available schemes: ${schemes.join(", ")}`,
            "XCODE_NO_SCHEMES",
          );
        }
        scheme = args.scheme;
      } else {
        scheme = pickReleaseScheme(schemes);
      }

      const ts = Date.now();
      const archivePath = join(info.buildDir, `claude-tf-${ts}.xcarchive`);
      validatePathContainment(archivePath, info.buildDir);
      const exportPath = join(info.buildDir, `claude-tf-${ts}-export`);
      validatePathContainment(exportPath, info.buildDir);

      await archiveApp({
        projectInfo: info,
        scheme,
        configuration: args.configuration,
        archivePath,
        auth,
      });
      const exportOptionsPlist = await writeExportOptionsPlist(info.buildDir, {
        destination: "export",
      });
      const { ipaPath } = await exportArchive({ archivePath, exportOptionsPlist, exportPath, auth });
      if (!ipaPath) {
        throw new MobileError(
          `Export succeeded but no .ipa was found in ${exportPath}.`,
          "IPA_NOT_FOUND",
        );
      }

      const duration = ((Date.now() - started) / 1000).toFixed(1);
      return textResult(
        `IPA built: ${ipaPath}\nScheme: ${scheme}\nDuration: ${duration}s\n` +
          `Next: appstore_upload {"ipaPath": "${ipaPath}"}`,
      );
    },
  }),

  defineTool({
    name: "appstore_upload",
    description:
      "Upload an .ipa to App Store Connect (TestFlight) via altool. " +
      "Requires ASC_KEY_ID + ASC_ISSUER_ID env (key file in ~/.appstoreconnect/private/keys/).",
    schema: z.object({
      ipaPath: z.string().describe("Absolute path to the .ipa file"),
    }),
    handler: async (args) => {
      validatePath(args.ipaPath, "ipaPath");
      if (!args.ipaPath.endsWith(".ipa")) {
        throw new ValidationError(`ipaPath must point to an .ipa file, got: ${args.ipaPath}`);
      }
      const auth = getAscAuthFromEnv();
      await uploadIpa({ ipaPath: args.ipaPath, keyId: auth.keyId, issuerId: auth.issuerId });
      return textResult(
        "Upload accepted by App Store Connect. Processing typically takes 5-15 minutes.\n" +
          "Poll with appstore_get_releases until the build state is VALID, then appstore_promote.",
      );
    },
  }),

  defineTool({
    name: "appstore_get_releases",
    description:
      "List TestFlight builds with processing state. " +
      "Single poll per call — re-call while a build is PROCESSING.",
    schema: z.object({
      bundleId: z.string().describe("App bundle ID (e.g. com.example.app)"),
      version: z.string().optional().describe("Filter by marketing version (e.g. 1.2.3)"),
    }),
    handler: async (args) => {
      validateBundleId(args.bundleId);
      if (args.version !== undefined) validateVersionString(args.version);

      const app = await client().findApp(args.bundleId);
      const builds = await client().getBuilds(app.id, { version: args.version, limit: 5 });
      if (builds.length === 0) {
        return textResult(
          `No builds found for ${app.name} (${args.bundleId})` +
            `${args.version ? ` version ${args.version}` : ""}. ` +
            "If you just uploaded, the build may not be visible yet — re-call in ~30s.",
        );
      }

      let out = `Builds for ${app.name} (${args.bundleId}):\n${renderBuildsTable(builds)}`;
      if (builds.some((b) => b.processingState === "PROCESSING")) {
        out +=
          "\n\nA build is still PROCESSING — call appstore_get_releases again in ~30s " +
          "(processing typically takes 5-15 minutes).";
      }
      return textResult(out);
    },
  }),

  defineTool({
    name: "appstore_set_notes",
    description:
      'Set TestFlight "What to Test" notes for a build (defaults to the latest VALID build).',
    schema: z.object({
      bundleId: z.string().describe("App bundle ID"),
      buildId: z.string().optional().describe("Build ID (default: latest VALID build)"),
      whatsNew: z.string().describe("What to Test text (max 4000 characters)"),
      locale: z.string().default("en-US").describe("BCP-47 locale (default: en-US)"),
    }),
    handler: async (args) => {
      validateBundleId(args.bundleId);
      validateLocale(args.locale);
      if (args.whatsNew.length === 0 || args.whatsNew.length > WHATS_NEW_MAX_CHARS) {
        throw new ValidationError(
          `whatsNew must be 1-${WHATS_NEW_MAX_CHARS} characters (got ${args.whatsNew.length}).`,
        );
      }

      const resolved = await resolveBuild(args.bundleId, args.buildId);
      await client().setWhatToTest(resolved.buildId, args.whatsNew, args.locale);
      return textResult(
        `"What to Test" set for build ${resolved.version ?? resolved.buildId} ` +
          `(${args.locale}, ${args.whatsNew.length}/${WHATS_NEW_MAX_CHARS} chars).`,
      );
    },
  }),

  defineTool({
    name: "appstore_promote",
    description:
      "Promote a TestFlight build: add it to a beta group by group name " +
      "(defaults to the latest VALID build). " +
      "External groups are auto-submitted for beta review unless submitReview=false.",
    schema: z.object({
      bundleId: z.string().describe("App bundle ID"),
      groupName: z.string().describe("Beta group name as shown in App Store Connect"),
      buildId: z.string().optional().describe("Build ID (default: latest VALID build)"),
      submitReview: z
        .boolean()
        .optional()
        .describe("Submit for external beta review when the group is external (default: true)"),
    }),
    handler: async (args) => {
      validateBundleId(args.bundleId);
      if (args.groupName.length === 0 || args.groupName.length > 128) {
        throw new ValidationError("groupName must be 1-128 characters.");
      }

      const resolved = await resolveBuild(args.bundleId, args.buildId);
      const groups = await client().getBetaGroups(resolved.appId);
      const group = groups.find((g) => g.name === args.groupName);
      if (!group) {
        const available = groups.map((g) => `"${g.name}"${g.isInternal ? " (internal)" : ""}`).join(", ");
        throw new MobileError(
          `Beta group "${args.groupName}" not found for ${args.bundleId}. ` +
            `Available groups: ${available || "none"}`,
          "TESTFLIGHT_GROUP_NOT_FOUND",
        );
      }

      await client().addBuildToGroup(group.id, resolved.buildId);
      let out = `Build ${resolved.version ?? resolved.buildId} added to ${group.isInternal ? "internal" : "external"} group "${group.name}".`;

      if (!group.isInternal && args.submitReview !== false) {
        try {
          await client().submitForBetaReview(resolved.buildId);
          out += "\nSubmitted for external beta review.";
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Re-distributing an already-reviewed build is not a failure.
          if (/already|409/i.test(msg)) {
            out += "\nBeta review already submitted for this build — nothing to do.";
          } else {
            throw err;
          }
        }
      }
      return textResult(out);
    },
  }),

  defineTool({
    name: "appstore_submit",
    description: "Submit a TestFlight build for external beta review (defaults to the latest VALID build).",
    schema: z.object({
      bundleId: z.string().describe("App bundle ID"),
      buildId: z.string().optional().describe("Build ID (default: latest VALID build)"),
    }),
    handler: async (args) => {
      validateBundleId(args.bundleId);
      const resolved = await resolveBuild(args.bundleId, args.buildId);
      await client().submitForBetaReview(resolved.buildId);
      return textResult(
        `Build ${resolved.version ?? resolved.buildId} submitted for external beta review.`,
      );
    },
  }),
];
