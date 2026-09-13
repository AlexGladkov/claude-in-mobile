package com.anthropic.desktop.accessibility

import com.anthropic.desktop.*
import java.time.Duration

/**
 * macOS Accessibility implementation
 * Uses AppleScript as a simpler alternative to JNA AXUIElement bindings
 */
class MacOSAccessibility : BaseAccessibilityService() {
    private val processRunner = SecureProcessRunner()


    // Cache UI hierarchy to avoid repeated expensive AppleScript calls
    @Volatile
    private var cachedHierarchy: UiHierarchy? = null
    @Volatile
    private var hierarchyCacheTimestamp: Long = 0
    private val HIERARCHY_CACHE_TTL_MS = 5000L // 5 seconds cache

    companion object {
        private const val APPLESCRIPT_TIMEOUT_SECONDS = 20L
    }

    override fun checkPermissions(): PermissionStatus {
        return try {
            // Check if we have accessibility permissions by trying to get frontmost app
            val script = """
                tell application "System Events"
                    name of first application process whose frontmost is true
                end tell
            """.trimIndent()

            val result = processRunner.run(
                listOf("osascript", "-e", script),
                Duration.ofSeconds(5)
            )

            if (result.succeeded) {
                PermissionStatus(granted = true)
            } else {
                openAccessibilityPreferences()
                PermissionStatus(
                    granted = false,
                    instructions = listOf(
                        "1. System Settings > Privacy & Security > Accessibility",
                        "2. Click the lock to make changes",
                        "3. Enable access for Terminal or your IDE",
                        "4. Restart the MCP server"
                    )
                )
            }
        } catch (_: Exception) {
            openAccessibilityPreferences()
            PermissionStatus(
                granted = false,
                instructions = listOf(
                    "1. Open System Settings > Privacy & Security > Accessibility",
                    "2. Enable access for Terminal or your IDE",
                    "3. Restart the MCP server",
                    "Accessibility permission check failed"
                )
            )
        }
    }

    private fun openAccessibilityPreferences() {
        try {
            processRunner.run(
                listOf(
                    "open",
                    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
                ),
                Duration.ofSeconds(5)
            )
        } catch (_: Exception) {
            System.err.println("Failed to open accessibility preferences")
        }
    }

    override fun getHierarchy(windowId: String?): UiHierarchy {
        val now = System.currentTimeMillis()
        val cached = cachedHierarchy

        // Return cached hierarchy if fresh (UI doesn't change that fast)
        if (cached != null && (now - hierarchyCacheTimestamp) < HIERARCHY_CACHE_TTL_MS) {
            System.err.println("Returning cached UI hierarchy (age: ${now - hierarchyCacheTimestamp}ms)")
            return cached
        }

        resetIndex()
        val windows = windowManager.getWindows()
        val scaleFactor = ScreenCapture().getScaleFactor()

        // Try to get UI elements from frontmost app (with timeout)
        val elements = try {
            getUIElementsFromFrontmostApp()
        } catch (_: Exception) {
            System.err.println("Failed to get UI elements")
            // Fallback: return simplified elements from windows
            getSimplifiedElements(windows)
        }

        cachedElements = elements

        val hierarchy = UiHierarchy(
            windows = windows,
            elements = elements,
            scaleFactor = scaleFactor
        )

        // Update cache
        cachedHierarchy = hierarchy
        hierarchyCacheTimestamp = now

        return hierarchy
    }

    /**
     * Simplified fallback - return only window bounds (no deep UI traversal)
     */
    private fun getSimplifiedElements(windows: List<WindowInfo>): List<UiElement> {
        return windows.map { win ->
            createElement(
                text = win.title,
                role = "AXWindow",
                x = win.bounds.x,
                y = win.bounds.y,
                width = win.bounds.width,
                height = win.bounds.height,
                clickable = true
            )
        }
    }

    private fun getUIElementsFromFrontmostApp(): List<UiElement> {
        val elements = mutableListOf<UiElement>()

        try {
            // Get UI elements using AppleScript
            // FIXED: Limited depth traversal (2 levels) instead of "entire contents"
            // This prevents 10-20 second timeouts on complex windows
            val script = """
                tell application "System Events"
                    set frontApp to first application process whose frontmost is true
                    set uiElements to {}

                    tell frontApp
                        repeat with win in windows
                            -- Get window info
                            set winPos to position of win
                            set winSize to size of win

                            -- FIXED: Only get direct children (depth=1), NOT "entire contents"
                            -- This avoids exponential traversal time
                            repeat with elem in (UI elements of win)
                                try
                                    set elemRole to role of elem
                                    set elemTitle to ""
                                    set elemDesc to ""
                                    set elemPos to {0, 0}
                                    set elemSize to {0, 0}
                                    set elemEnabled to true
                                    set elemFocused to false

                                    try
                                        set elemTitle to title of elem
                                    end try
                                    try
                                        if elemTitle is "" then set elemTitle to value of elem
                                    end try
                                    try
                                        set elemDesc to description of elem
                                    end try
                                    try
                                        set elemPos to position of elem
                                    end try
                                    try
                                        set elemSize to size of elem
                                    end try
                                    try
                                        set elemEnabled to enabled of elem
                                    end try
                                    try
                                        set elemFocused to focused of elem
                                    end try

                                    if item 1 of elemSize > 0 and item 2 of elemSize > 0 then
                                        set end of uiElements to {elemRole, elemTitle, elemDesc, item 1 of elemPos, item 2 of elemPos, item 1 of elemSize, item 2 of elemSize, elemEnabled, elemFocused}
                                    end if

                                    -- Depth=2: Get children of containers (but no deeper)
                                    if elemRole is in {"AXGroup", "AXScrollArea", "AXSplitGroup", "AXTabGroup"} then
                                        try
                                            repeat with child in (UI elements of elem)
                                                try
                                                    set childRole to role of child
                                                    set childTitle to ""
                                                    set childPos to {0, 0}
                                                    set childSize to {0, 0}
                                                    set childEnabled to true
                                                    set childFocused to false

                                                    try
                                                        set childTitle to title of child
                                                    end try
                                                    try
                                                        if childTitle is "" then set childTitle to value of child
                                                    end try
                                                    try
                                                        set childPos to position of child
                                                    end try
                                                    try
                                                        set childSize to size of child
                                                    end try
                                                    try
                                                        set childEnabled to enabled of child
                                                    end try
                                                    try
                                                        set childFocused to focused of child
                                                    end try

                                                    if item 1 of childSize > 0 and item 2 of childSize > 0 then
                                                        set end of uiElements to {childRole, childTitle, "", item 1 of childPos, item 2 of childPos, item 1 of childSize, item 2 of childSize, childEnabled, childFocused}
                                                    end if
                                                end try
                                            end repeat
                                        end try
                                    end if
                                end try
                            end repeat
                        end repeat
                    end tell

                    return uiElements
                end tell
            """.trimIndent()

            val result = processRunner.run(
                listOf("osascript", "-e", script),
                Duration.ofSeconds(APPLESCRIPT_TIMEOUT_SECONDS)
            )
            if (result.timedOut) {
                System.err.println("AppleScript UI hierarchy timeout")
                return elements
            }
            if (!result.succeeded) {
                System.err.println("AppleScript UI elements failed")
            } else if (result.stdout.isNotBlank()) {
                parseAppleScriptElements(result.stdout, elements)
            }
        } catch (_: Exception) {
            System.err.println("Error getting UI elements")
        }

        // If no elements found, provide at least screen bounds
        if (elements.isEmpty()) {
            val screenSize = ScreenCapture().getScreenSize()
            elements.add(
                createElement(
                    text = "Screen",
                    role = "AXWindow",
                    x = 0,
                    y = 0,
                    width = screenSize.first,
                    height = screenSize.second,
                    clickable = true
                )
            )
        }

        return elements
    }

    private fun parseAppleScriptElements(output: String, elements: MutableList<UiElement>) {
        // Parse AppleScript list output
        // Format: {{role, title, desc, x, y, w, h, enabled, focused}, ...}
        val pattern = Regex("""\{([^,]*),\s*([^,]*),\s*([^,]*),\s*(-?\d+),\s*(-?\d+),\s*(\d+),\s*(\d+),\s*(true|false),\s*(true|false)\}""")

        pattern.findAll(output).forEach { match ->
            val groups = match.groupValues
            val role = groups[1].trim()
            val title = groups[2].trim()
            val x = groups[4].toIntOrNull() ?: 0
            val y = groups[5].toIntOrNull() ?: 0
            val w = groups[6].toIntOrNull() ?: 0
            val h = groups[7].toIntOrNull() ?: 0
            val enabled = groups[8] == "true"
            val focused = groups[9] == "true"

            // Determine if clickable based on role
            val clickable = role in listOf(
                "AXButton", "AXLink", "AXCheckBox", "AXRadioButton",
                "AXMenuItem", "AXMenuButton", "AXTab", "AXTextField",
                "AXTextArea", "AXComboBox", "AXPopUpButton"
            )

            elements.add(
                createElement(
                    text = title.ifEmpty { null },
                    id = null,
                    role = role,
                    x = x,
                    y = y,
                    width = w,
                    height = h,
                    clickable = clickable,
                    enabled = enabled,
                    focused = focused
                )
            )
        }
    }
}
