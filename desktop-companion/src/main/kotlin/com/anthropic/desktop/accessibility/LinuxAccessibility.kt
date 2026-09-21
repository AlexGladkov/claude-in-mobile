package com.anthropic.desktop.accessibility

import com.anthropic.desktop.*

/**
 * Linux Accessibility implementation
 * Uses AT-SPI2 via D-Bus
 *
 * Note: Full implementation requires D-Bus Java bindings
 * This is a simplified version that provides basic window information
 */
class LinuxAccessibility : BaseAccessibilityService() {
    private val processRunner = SecureProcessRunner()


    override fun checkPermissions(): PermissionStatus {
        // Check if AT-SPI2 is running
        return try {
            val result = processRunner.run(
                listOf("pgrep", "-x", "at-spi2-registryd"),
                java.time.Duration.ofSeconds(5)
            )

            if (result.succeeded) {
                PermissionStatus(granted = true)
            } else {
                PermissionStatus(
                    granted = false,
                    instructions = listOf(
                        "AT-SPI2 accessibility service is not running.",
                        "Install and enable it with:",
                        "  sudo apt install at-spi2-core",
                        "  systemctl --user enable at-spi-dbus-bus.service",
                        "  systemctl --user start at-spi-dbus-bus.service"
                    )
                )
            }
        } catch (_: Exception) {
            PermissionStatus(
                granted = false,
                instructions = listOf("Unable to verify that AT-SPI2 is running.")
            )
        }
    }

    override fun getHierarchy(windowId: String?): UiHierarchy {
        resetIndex()
        val windows = windowManager.getWindows()
        val scaleFactor = ScreenCapture().getScaleFactor()

        // Basic implementation - just return window information
        // Full AT-SPI2 would require D-Bus bindings
        val elements = windows.map { window ->
            createElement(
                text = window.title,
                id = window.id,
                role = "Window",
                x = window.bounds.x,
                y = window.bounds.y,
                width = window.bounds.width,
                height = window.bounds.height,
                clickable = true,
                enabled = true,
                focused = window.focused
            )
        }

        cachedElements = elements

        return UiHierarchy(
            windows = windows,
            elements = elements,
            scaleFactor = scaleFactor
        )
    }
}
