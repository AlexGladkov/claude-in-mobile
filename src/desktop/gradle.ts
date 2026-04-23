/**
 * Gradle task detection and launcher for Compose Desktop projects
 */

import { execSync, spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import type { GradleProject, LaunchOptions } from "./types.js";

// Known desktop run task patterns
const DESKTOP_TASK_PATTERNS = [
  ":desktopApp:run",
  ":composeApp:desktopRun",
  ":desktop:run",
  ":app:desktopRun",
  "desktopRun",
  "runDesktop",
];

export class GradleLauncher {
  /**
   * Check if Gradle wrapper exists in project
   */
  hasGradleWrapper(projectPath: string): boolean {
    const wrapperScript = process.platform === "win32" ? "gradlew.bat" : "gradlew";
    const wrapperPath = path.join(projectPath, wrapperScript);
    return fs.existsSync(wrapperPath);
  }

  /**
   * Get Gradle executable (wrapper or system gradle)
   */
  private getGradleExecutable(projectPath: string): string {
    if (this.hasGradleWrapper(projectPath)) {
      return process.platform === "win32"
        ? path.join(projectPath, "gradlew.bat")
        : path.join(projectPath, "gradlew");
    }
    return "gradle";
  }

  /**
   * Detect available desktop run tasks in the project
   */
  async detectDesktopTasks(projectPath: string): Promise<string[]> {
    const gradle = this.getGradleExecutable(projectPath);

    try {
      // Run gradle tasks and parse output
      const output = execSync(`"${gradle}" tasks --all`, {
        cwd: projectPath,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60000,
      });

      const tasks: string[] = [];
      const lines = output.split("\n");

      for (const line of lines) {
        const trimmed = line.trim();
        // Look for task lines (format: "taskName - description" or just "taskName")
        const taskMatch = trimmed.match(/^(:\S+|[a-zA-Z]\S*)\s*(-|$)/);
        if (taskMatch) {
          const taskName = taskMatch[1];
          // Check if it matches known desktop patterns
          for (const pattern of DESKTOP_TASK_PATTERNS) {
            if (taskName.includes(pattern) ||
                taskName.toLowerCase().includes("desktop") && taskName.toLowerCase().includes("run")) {
              tasks.push(taskName);
              break;
            }
          }
        }
      }

      // Deduplicate and sort
      return [...new Set(tasks)].sort();
    } catch {
      // Fallback: check common task names directly
      const commonTasks: string[] = [];

      for (const pattern of DESKTOP_TASK_PATTERNS) {
        try {
          execSync(`"${gradle}" ${pattern} --dry-run`, {
            cwd: projectPath,
            encoding: "utf-8",
            timeout: 30000,
            stdio: "pipe",
          });
          commonTasks.push(pattern);
        } catch {
          // Task doesn't exist
        }
      }

      return commonTasks;
    }
  }

  /**
   * Analyze Gradle project and return info
   */
  async analyzeProject(projectPath: string): Promise<GradleProject> {
    if (!fs.existsSync(projectPath)) {
      throw new Error(`Project path does not exist: ${projectPath}`);
    }

    // Check for build.gradle or build.gradle.kts
    const hasBuildGradle =
      fs.existsSync(path.join(projectPath, "build.gradle")) ||
      fs.existsSync(path.join(projectPath, "build.gradle.kts"));

    if (!hasBuildGradle) {
      throw new Error(`No build.gradle or build.gradle.kts found in: ${projectPath}`);
    }

    const desktopTasks = await this.detectDesktopTasks(projectPath);

    return {
      path: projectPath,
      desktopTasks,
      selectedTask: desktopTasks[0], // Default to first detected task
    };
  }

  /**
   * Launch desktop app via Gradle
   * Returns the spawned process
   */
  launch(options: LaunchOptions): ChildProcess {
    const { projectPath, task, jvmArgs = [], env = {} } = options;

    if (!projectPath) {
      throw new Error("projectPath is required to launch via Gradle");
    }

    if (!fs.existsSync(projectPath)) {
      throw new Error(`Project path does not exist: ${projectPath}`);
    }

    const gradle = this.getGradleExecutable(projectPath);

    // Determine task to run
    let targetTask = task;
    if (!targetTask) {
      // Auto-detect
      const detected = this.detectDesktopTasksSync(projectPath);
      if (detected.length === 0) {
        throw new Error(
          `No desktop run task found in project. ` +
          `Please specify task explicitly or ensure project has Compose Desktop configured.`
        );
      }
      targetTask = detected[0];
    }

    // Build command args
    const args: string[] = [targetTask];

    // Add JVM args
    if (jvmArgs.length > 0) {
      args.push(`-Dorg.gradle.jvmargs=${jvmArgs.join(" ")}`);
    }

    // Add --console=plain for cleaner output
    args.push("--console=plain");

    // Merge environment
    const processEnv = {
      ...process.env,
      ...env,
    };

    // Spawn Gradle process
    const child = spawn(gradle, args, {
      cwd: projectPath,
      env: processEnv,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    return child;
  }

  /**
   * Synchronous version of detectDesktopTasks (for launch)
   */
  private detectDesktopTasksSync(projectPath: string): string[] {
    const gradle = this.getGradleExecutable(projectPath);
    const tasks: string[] = [];

    // Quick check for common patterns
    for (const pattern of DESKTOP_TASK_PATTERNS) {
      try {
        execSync(`"${gradle}" ${pattern} --dry-run`, {
          cwd: projectPath,
          encoding: "utf-8",
          timeout: 30000,
          stdio: "pipe",
        });
        tasks.push(pattern);
      } catch {
        // Task doesn't exist
      }
    }

    return tasks;
  }

  /**
   * Stop a running Gradle process
   */
  stop(process: ChildProcess): void {
    if (process && !process.killed) {
      // Try graceful shutdown first
      process.kill("SIGTERM");

      // Force kill after timeout
      setTimeout(() => {
        if (!process.killed) {
          process.kill("SIGKILL");
        }
      }, 5000);
    }
  }

  /**
   * Check if Gradle daemon is running
   */
  isGradleDaemonRunning(projectPath: string): boolean {
    const gradle = this.getGradleExecutable(projectPath);
    try {
      const output = execSync(`"${gradle}" --status`, {
        cwd: projectPath,
        encoding: "utf-8",
        timeout: 10000,
      });
      return output.includes("IDLE") || output.includes("BUSY");
    } catch {
      return false;
    }
  }

  /**
   * Stop Gradle daemon
   */
  stopGradleDaemon(projectPath: string): void {
    const gradle = this.getGradleExecutable(projectPath);
    try {
      execSync(`"${gradle}" --stop`, {
        cwd: projectPath,
        encoding: "utf-8",
        timeout: 30000,
      });
    } catch {
      // Ignore errors
    }
  }
}
