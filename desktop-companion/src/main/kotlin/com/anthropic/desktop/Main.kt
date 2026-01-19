package com.anthropic.desktop

import com.anthropic.desktop.accessibility.AccessibilityService
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement

/**
 * Desktop Companion App - Entry Point
 *
 * This application serves as a bridge between the MCP server (Node.js)
 * and the desktop OS for UI automation.
 *
 * Communication: stdin/stdout JSON-RPC
 */
fun main() = runBlocking {
    System.err.println("Starting Desktop Companion...")

    // Initialize components
    val inputController = InputController()
    val screenCapture = ScreenCapture()
    val windowManager = WindowManager()
    val clipboardManager = ClipboardManager()
    val accessibility = AccessibilityService.create()

    // Create JSON-RPC server
    val server = JsonRpcServer()

    // Register handlers

    // Screenshot (with multi-monitor support)
    server.registerTypedHandler("screenshot") { params ->
        val windowId = params.string("windowId")
        val quality = params.int("quality") ?: 80
        val monitorIndex = params.int("monitorIndex")
        screenCapture.capture(windowId, quality, monitorIndex)
    }

    // Get list of monitors
    server.registerTypedHandler("get_monitors") { _ ->
        MonitorsResult(monitors = screenCapture.getMonitors())
    }

    // Tap
    server.registerVoidHandler("tap") { params ->
        val x = params.intOrThrow("x")
        val y = params.intOrThrow("y")
        inputController.tap(x, y)
    }

    // Double tap
    server.registerVoidHandler("double_tap") { params ->
        val x = params.intOrThrow("x")
        val y = params.intOrThrow("y")
        inputController.doubleTap(x, y)
    }

    // Long press
    server.registerVoidHandler("long_press") { params ->
        val x = params.intOrThrow("x")
        val y = params.intOrThrow("y")
        val durationMs = params.int("durationMs") ?: 1000
        inputController.longPress(x, y, durationMs)
    }

    // Right click
    server.registerVoidHandler("right_click") { params ->
        val x = params.intOrThrow("x")
        val y = params.intOrThrow("y")
        inputController.rightClick(x, y)
    }

    // Swipe
    server.registerVoidHandler("swipe") { params ->
        val x1 = params.intOrThrow("x1")
        val y1 = params.intOrThrow("y1")
        val x2 = params.intOrThrow("x2")
        val y2 = params.intOrThrow("y2")
        val durationMs = params.int("durationMs") ?: 300
        inputController.swipe(x1, y1, x2, y2, durationMs)
    }

    // Swipe direction
    server.registerVoidHandler("swipe_direction") { params ->
        val direction = params.stringOrThrow("direction")
        val distance = params.int("distance") ?: 400
        inputController.swipeDirection(direction, distance)
    }

    // Scroll
    server.registerVoidHandler("scroll") { params ->
        val amount = params.intOrThrow("amount")
        val x = params.int("x")
        val y = params.int("y")
        inputController.scroll(amount, x, y)
    }

    // Input text
    server.registerVoidHandler("input_text") { params ->
        val text = params.stringOrThrow("text")
        inputController.typeText(text)
    }

    // Key event
    server.registerVoidHandler("key_event") { params ->
        val key = params.stringOrThrow("key")
        val modifiers = params.stringList("modifiers")
        inputController.keyEvent(key, modifiers)
    }

    // Get UI hierarchy
    server.registerTypedHandler("get_ui_hierarchy") { params ->
        val windowId = params.string("windowId")
        accessibility.getHierarchy(windowId)
    }

    // Get window info
    server.registerTypedHandler("get_window_info") { _ ->
        windowManager.getWindowListResult()
    }

    // Focus window
    server.registerVoidHandler("focus_window") { params ->
        val windowId = params.stringOrThrow("windowId")
        windowManager.focusWindow(windowId)
    }

    // Resize window
    server.registerVoidHandler("resize_window") { params ->
        val windowId = params.string("windowId")
        val width = params.intOrThrow("width")
        val height = params.intOrThrow("height")
        windowManager.resizeWindow(windowId, width, height)
    }

    // Get clipboard
    server.registerTypedHandler("get_clipboard") { _ ->
        ClipboardContent(text = clipboardManager.getText())
    }

    // Set clipboard
    server.registerVoidHandler("set_clipboard") { params ->
        val text = params.stringOrThrow("text")
        clipboardManager.setText(text)
    }

    // Check permissions
    server.registerTypedHandler("check_permissions") { _ ->
        accessibility.checkPermissions()
    }

    // Get performance metrics
    server.registerTypedHandler("get_performance_metrics") { _ ->
        val runtime = Runtime.getRuntime()
        val usedMemory = (runtime.totalMemory() - runtime.freeMemory()) / (1024 * 1024)

        PerformanceMetrics(
            memoryUsageMb = usedMemory,
            cpuPercent = null // Would require platform-specific code
        )
    }

    // Get screen size
    server.registerTypedHandler("get_screen_size") { _ ->
        val (width, height) = screenCapture.getScreenSize()
        ScreenSizeResult(width = width, height = height)
    }

    // Get scale factor
    server.registerTypedHandler("get_scale_factor") { _ ->
        ScaleFactorResult(scaleFactor = screenCapture.getScaleFactor())
    }

    // Ping (for health check)
    server.registerTypedHandler("ping") { _ ->
        PingResult(status = "ok", timestamp = System.currentTimeMillis())
    }

    // Start server (blocking)
    System.err.println("Desktop Companion ready - listening for commands")
    server.start()
}
