package com.anthropic.desktop

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * JSON-RPC types
 */
@Serializable
data class JsonRpcRequest(
    val jsonrpc: String = "2.0",
    val id: Int,
    val method: String,
    val params: JsonElement? = null
)

@Serializable
data class JsonRpcResponse(
    val jsonrpc: String = "2.0",
    val id: Int,
    val result: JsonElement? = null,
    val error: JsonRpcError? = null
)

@Serializable
data class JsonRpcError(
    val code: Int,
    val message: String,
    val data: JsonElement? = null
)

/**
 * Geometry types
 */
@Serializable
data class Bounds(
    val x: Int,
    val y: Int,
    val width: Int,
    val height: Int
)

/**
 * Window types
 */
@Serializable
data class WindowInfo(
    val id: String,
    val title: String,
    val bounds: Bounds,
    val focused: Boolean,
    val minimized: Boolean = false,
    val fullscreen: Boolean = false,
    val processId: Int? = null,
    val ownerName: String? = null
)

@Serializable
data class WindowListResult(
    val windows: List<WindowInfo>,
    val activeWindowId: String?
)

/**
 * UI element types
 */
@Serializable
data class UiElement(
    val index: Int,
    val id: String? = null,
    val text: String? = null,
    val contentDescription: String? = null,
    val className: String,
    val role: String? = null,
    val bounds: Bounds,
    val clickable: Boolean,
    val enabled: Boolean,
    val focused: Boolean,
    val focusable: Boolean = false,
    val centerX: Int,
    val centerY: Int,
    val children: List<UiElement> = emptyList()
)

@Serializable
data class UiHierarchy(
    val windows: List<WindowInfo>,
    val elements: List<UiElement>,
    val scaleFactor: Double
)

/**
 * Screenshot result
 */
@Serializable
data class ScreenshotResult(
    val base64: String,
    val width: Int,
    val height: Int,
    val scaleFactor: Double,
    val mimeType: String = "image/jpeg"
)

/**
 * Performance metrics
 */
@Serializable
data class PerformanceMetrics(
    val fps: Int? = null,
    val memoryUsageMb: Long,
    val cpuPercent: Int? = null
)

/**
 * Permission status
 */
@Serializable
data class PermissionStatus(
    val granted: Boolean,
    val instructions: List<String>? = null
)

/**
 * Clipboard content
 */
@Serializable
data class ClipboardContent(
    val text: String?
)

/**
 * Ping result
 */
@Serializable
data class PingResult(
    val status: String,
    val timestamp: Long
)

/**
 * Screen size result
 */
@Serializable
data class ScreenSizeResult(
    val width: Int,
    val height: Int
)

/**
 * Scale factor result
 */
@Serializable
data class ScaleFactorResult(
    val scaleFactor: Double
)

/**
 * Monitor information result
 */
@Serializable
data class MonitorsResult(
    val monitors: List<MonitorInfo>
)
