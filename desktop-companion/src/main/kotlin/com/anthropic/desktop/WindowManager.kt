package com.anthropic.desktop

import com.sun.jna.Native
import com.sun.jna.Pointer
import com.sun.jna.platform.mac.CoreFoundation.*
import com.sun.jna.platform.win32.User32
import com.sun.jna.platform.win32.WinDef
import com.sun.jna.platform.win32.WinUser
import java.awt.Rectangle

/**
 * Cross-platform window management
 */
class WindowManager {
    private val isMac = System.getProperty("os.name").lowercase().contains("mac")
    private val isWindows = System.getProperty("os.name").lowercase().contains("windows")

    /**
     * Get list of all visible windows
     */
    fun getWindows(): List<WindowInfo> {
        return when {
            isMac -> getMacWindows()
            isWindows -> getWindowsWindows()
            else -> getLinuxWindows()
        }
    }

    /**
     * Get window info result with active window
     */
    fun getWindowListResult(): WindowListResult {
        val windows = getWindows()
        val activeId = windows.find { it.focused }?.id
        return WindowListResult(windows, activeId)
    }

    /**
     * Get bounds of a specific window
     */
    fun getWindowBounds(windowId: String): Rectangle {
        val windows = getWindows()
        val window = windows.find { it.id == windowId }
            ?: throw IllegalArgumentException("Window not found: $windowId")

        return Rectangle(
            window.bounds.x,
            window.bounds.y,
            window.bounds.width,
            window.bounds.height
        )
    }

    /**
     * Focus a window
     */
    fun focusWindow(windowId: String) {
        when {
            isMac -> focusMacWindow(windowId)
            isWindows -> focusWindowsWindow(windowId)
            else -> focusLinuxWindow(windowId)
        }
    }

    /**
     * Resize a window
     */
    fun resizeWindow(windowId: String?, width: Int, height: Int) {
        when {
            isMac -> resizeMacWindow(windowId, width, height)
            isWindows -> resizeWindowsWindow(windowId, width, height)
            else -> resizeLinuxWindow(windowId, width, height)
        }
    }

    // ============ macOS Implementation ============

    private fun getMacWindows(): List<WindowInfo> {
        val windows = mutableListOf<WindowInfo>()

        try {
            // Use AppleScript to get window list - includes ALL processes (not just foreground)
            // This script also catches Java/Kotlin/Compose Desktop apps
            val script = """
                tell application "System Events"
                    set windowList to {}
                    -- Get all processes with windows (not just foreground apps)
                    repeat with proc in (processes whose visible is true)
                        set procName to name of proc
                        try
                            repeat with win in windows of proc
                                try
                                    set winName to name of win
                                    set winPos to position of win
                                    set winSize to size of win
                                    set end of windowList to {procName, winName, item 1 of winPos, item 2 of winPos, item 1 of winSize, item 2 of winSize}
                                end try
                            end repeat
                        end try
                    end repeat
                    return windowList
                end tell
            """.trimIndent()

            val process = ProcessBuilder("osascript", "-e", script).start()
            val output = process.inputStream.bufferedReader().readText()
            process.waitFor()

            // Parse AppleScript output
            // Format: {{procName, winName, x, y, w, h}, ...}
            parseAppleScriptWindowList(output, windows)
        } catch (e: Exception) {
            System.err.println("Error getting macOS windows: ${e.message}")
        }

        // Additionally scan for Java/JVM processes that might not appear in standard list
        try {
            val javaScript = """
                tell application "System Events"
                    set javaWindows to {}
                    -- Scan for java, kotlin, JetBrains, gradle processes
                    repeat with proc in processes
                        set procName to name of proc
                        if procName contains "java" or procName contains "kotlin" or procName contains "JetBrains" or procName contains "gradle" or procName contains "idea" then
                            try
                                repeat with win in windows of proc
                                    try
                                        set winName to name of win
                                        set winPos to position of win
                                        set winSize to size of win
                                        set end of javaWindows to {procName, winName, item 1 of winPos, item 2 of winPos, item 1 of winSize, item 2 of winSize}
                                    end try
                                end repeat
                            end try
                        end if
                    end repeat
                    return javaWindows
                end tell
            """.trimIndent()

            val javaProcess = ProcessBuilder("osascript", "-e", javaScript).start()
            val javaOutput = javaProcess.inputStream.bufferedReader().readText()
            javaProcess.waitFor()

            // Parse and add Java windows (avoid duplicates)
            val existingTitles = windows.map { it.title }.toSet()
            val javaWindows = mutableListOf<WindowInfo>()
            parseAppleScriptWindowList(javaOutput, javaWindows)

            javaWindows.forEach { win ->
                if (win.title !in existingTitles) {
                    windows.add(win.copy(id = "mac_java_${windows.size}"))
                }
            }
        } catch (e: Exception) {
            System.err.println("Error getting Java windows: ${e.message}")
        }

        // Get actual focused window
        try {
            val focusScript = """
                tell application "System Events"
                    set frontApp to first application process whose frontmost is true
                    return name of frontApp
                end tell
            """.trimIndent()

            val focusProcess = ProcessBuilder("osascript", "-e", focusScript).start()
            val focusedApp = focusProcess.inputStream.bufferedReader().readText().trim()
            focusProcess.waitFor()

            // Mark the focused app's first window as focused
            val focusedIndex = windows.indexOfFirst { it.ownerName == focusedApp }
            if (focusedIndex >= 0) {
                windows[focusedIndex] = windows[focusedIndex].copy(focused = true)
            } else if (windows.isNotEmpty()) {
                windows[0] = windows[0].copy(focused = true)
            }
        } catch (e: Exception) {
            // Fallback: mark first window as focused
            if (windows.isNotEmpty()) {
                windows[0] = windows[0].copy(focused = true)
            }
        }

        return windows
    }

    private fun parseAppleScriptWindowList(output: String, windows: MutableList<WindowInfo>) {
        // Simple parsing of AppleScript list output
        var index = 0
        val pattern = Regex("""\{([^,]+),\s*([^,]*),\s*(-?\d+),\s*(-?\d+),\s*(\d+),\s*(\d+)\}""")

        pattern.findAll(output).forEach { match ->
            val (procName, winName, x, y, w, h) = match.destructured
            windows.add(
                WindowInfo(
                    id = "mac_${index++}",
                    title = winName.trim().ifEmpty { procName.trim() },
                    bounds = Bounds(x.toInt(), y.toInt(), w.toInt(), h.toInt()),
                    focused = false,
                    ownerName = procName.trim()
                )
            )
        }
    }

    private fun focusMacWindow(windowId: String) {
        val windows = getMacWindows()
        val window = windows.find { it.id == windowId } ?: return

        // Strategy 1: Try direct application activation (works for native apps)
        var success = false
        try {
            val script1 = """
                tell application "${window.ownerName}"
                    activate
                end tell
            """.trimIndent()

            val proc1 = ProcessBuilder("osascript", "-e", script1).start()
            val exitCode = proc1.waitFor()
            success = exitCode == 0

            // Verify it actually worked
            if (success) {
                Thread.sleep(100) // Give time to switch
                val verifyScript = """
                    tell application "System Events"
                        set frontApp to first application process whose frontmost is true
                        return name of frontApp
                    end tell
                """.trimIndent()
                val verifyProc = ProcessBuilder("osascript", "-e", verifyScript).start()
                val frontApp = verifyProc.inputStream.bufferedReader().readText().trim()
                verifyProc.waitFor()
                success = frontApp == window.ownerName
            }
        } catch (e: Exception) {
            success = false
        }

        // Strategy 2: Use System Events for Java/background processes
        if (!success) {
            try {
                val script2 = """
                    tell application "System Events"
                        set frontmost of process "${window.ownerName}" to true
                    end tell
                """.trimIndent()
                ProcessBuilder("osascript", "-e", script2).start().waitFor()
            } catch (e: Exception) {
                System.err.println("Error focusing window via System Events: ${e.message}")
            }
        }

        // Strategy 3: Click on the window to bring it to front (last resort)
        if (!success) {
            try {
                val script3 = """
                    tell application "System Events"
                        tell process "${window.ownerName}"
                            try
                                perform action "AXRaise" of window 1
                            end try
                            set frontmost to true
                        end tell
                    end tell
                """.trimIndent()
                ProcessBuilder("osascript", "-e", script3).start().waitFor()
            } catch (e: Exception) {
                System.err.println("Error raising window: ${e.message}")
            }
        }
    }

    private fun resizeMacWindow(windowId: String?, width: Int, height: Int) {
        val script = """
            tell application "System Events"
                set frontApp to first application process whose frontmost is true
                tell frontApp
                    set size of window 1 to {$width, $height}
                end tell
            end tell
        """.trimIndent()

        ProcessBuilder("osascript", "-e", script).start().waitFor()
    }

    // ============ Windows Implementation ============

    private fun getWindowsWindows(): List<WindowInfo> {
        val windows = mutableListOf<WindowInfo>()

        try {
            val user32 = User32.INSTANCE
            val foreground = user32.GetForegroundWindow()

            user32.EnumWindows({ hwnd, _ ->
                if (user32.IsWindowVisible(hwnd)) {
                    val title = CharArray(512)
                    user32.GetWindowText(hwnd, title, 512)
                    val titleStr = String(title).trim('\u0000')

                    if (titleStr.isNotEmpty()) {
                        val rect = WinDef.RECT()
                        user32.GetWindowRect(hwnd, rect)

                        windows.add(
                            WindowInfo(
                                id = "win_${hwnd.pointer}",
                                title = titleStr,
                                bounds = Bounds(
                                    rect.left,
                                    rect.top,
                                    rect.right - rect.left,
                                    rect.bottom - rect.top
                                ),
                                focused = hwnd == foreground
                            )
                        )
                    }
                }
                true
            }, null)
        } catch (e: Exception) {
            System.err.println("Error getting Windows windows: ${e.message}")
        }

        return windows
    }

    private fun focusWindowsWindow(windowId: String) {
        try {
            val user32 = User32.INSTANCE
            // Extract pointer from window ID
            val ptrStr = windowId.removePrefix("win_")
            val ptr = Pointer(ptrStr.toLong())
            val hwnd = WinDef.HWND(ptr)

            user32.SetForegroundWindow(hwnd)
            user32.BringWindowToTop(hwnd)
        } catch (e: Exception) {
            System.err.println("Error focusing window: ${e.message}")
        }
    }

    private fun resizeWindowsWindow(windowId: String?, width: Int, height: Int) {
        try {
            val user32 = User32.INSTANCE
            val hwnd = if (windowId != null) {
                val ptrStr = windowId.removePrefix("win_")
                WinDef.HWND(Pointer(ptrStr.toLong()))
            } else {
                user32.GetForegroundWindow()
            }

            val rect = WinDef.RECT()
            user32.GetWindowRect(hwnd, rect)

            user32.MoveWindow(hwnd, rect.left, rect.top, width, height, true)
        } catch (e: Exception) {
            System.err.println("Error resizing window: ${e.message}")
        }
    }

    // ============ Linux Implementation ============

    private fun getLinuxWindows(): List<WindowInfo> {
        val windows = mutableListOf<WindowInfo>()

        try {
            // Use wmctrl to list windows
            val process = ProcessBuilder("wmctrl", "-l", "-G").start()
            val output = process.inputStream.bufferedReader().readText()
            process.waitFor()

            // Parse wmctrl output
            // Format: 0x12345678  0 x y w h hostname title
            val pattern = Regex("""(0x[0-9a-f]+)\s+\d+\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.*)""")

            pattern.findAll(output).forEach { match ->
                val (id, x, y, w, h, title) = match.destructured
                windows.add(
                    WindowInfo(
                        id = id,
                        title = title.trim(),
                        bounds = Bounds(x.toInt(), y.toInt(), w.toInt(), h.toInt()),
                        focused = false
                    )
                )
            }

            // Get active window
            val activeProcess = ProcessBuilder("xdotool", "getactivewindow").start()
            val activeId = activeProcess.inputStream.bufferedReader().readText().trim()
            activeProcess.waitFor()

            // Mark active window
            windows.replaceAll { win ->
                if (win.id.contains(activeId)) win.copy(focused = true) else win
            }
        } catch (e: Exception) {
            System.err.println("Error getting Linux windows: ${e.message}")
        }

        return windows
    }

    private fun focusLinuxWindow(windowId: String) {
        try {
            ProcessBuilder("wmctrl", "-i", "-a", windowId).start().waitFor()
        } catch (e: Exception) {
            System.err.println("Error focusing window: ${e.message}")
        }
    }

    private fun resizeLinuxWindow(windowId: String?, width: Int, height: Int) {
        try {
            val id = windowId ?: run {
                val process = ProcessBuilder("xdotool", "getactivewindow").start()
                val output = process.inputStream.bufferedReader().readText().trim()
                process.waitFor()
                output
            }

            ProcessBuilder("wmctrl", "-i", "-r", id, "-e", "0,-1,-1,$width,$height").start().waitFor()
        } catch (e: Exception) {
            System.err.println("Error resizing window: ${e.message}")
        }
    }
}
