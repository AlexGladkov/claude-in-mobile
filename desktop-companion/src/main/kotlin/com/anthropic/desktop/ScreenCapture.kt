package com.anthropic.desktop

import java.awt.GraphicsEnvironment
import java.awt.Rectangle
import java.awt.Robot
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.util.Base64
import javax.imageio.IIOImage
import javax.imageio.ImageIO
import javax.imageio.ImageWriteParam
import java.awt.RenderingHints
import java.awt.Image

/**
 * Handles screen capture with JPEG compression and HiDPI support
 */
class ScreenCapture {
    companion object {
        // API limit for many-image requests
        const val MAX_DIMENSION = 2000
        private const val MAX_SOURCE_DIMENSION = 32_768
        private const val MAX_SOURCE_PIXELS = 40_000_000L
    }
    private val robot = Robot()

    private fun validateCaptureBounds(bounds: Rectangle) {
        require(
            bounds.width in 1..MAX_SOURCE_DIMENSION &&
                bounds.height in 1..MAX_SOURCE_DIMENSION &&
                bounds.width.toLong() * bounds.height.toLong() <= MAX_SOURCE_PIXELS
        ) { "Capture bounds exceed the image safety limit" }
    }

    /**
     * Get the current scale factor
     */
    fun getScaleFactor(): Double {
        return try {
            val ge = GraphicsEnvironment.getLocalGraphicsEnvironment()
            val device = ge.defaultScreenDevice
            val config = device.defaultConfiguration
            config.defaultTransform.scaleX
        } catch (e: Exception) {
            1.0
        }
    }

    /**
     * Capture screenshot of a specific window or the entire screen
     */
    fun capture(windowId: String? = null, quality: Int = 80, monitorIndex: Int? = null): ScreenshotResult {
        require(quality in 1..100) { "JPEG quality must be between 1 and 100" }
        val ge = GraphicsEnvironment.getLocalGraphicsEnvironment()
        val scaleFactor = getScaleFactor()

        // Determine capture bounds
        val bounds = if (windowId != null) {
            WindowManager().getWindowBounds(windowId)
        } else {
            // Multi-monitor support
            val devices = ge.screenDevices
            when {
                monitorIndex != null && monitorIndex in devices.indices -> {
                    // Capture specific monitor
                    devices[monitorIndex].defaultConfiguration.bounds
                }
                monitorIndex != null -> throw IllegalArgumentException("Monitor index is out of range")
                devices.size == 1 -> {
                    // Single monitor - use simple bounds
                    devices[0].defaultConfiguration.bounds
                }
                else -> {
                    // Multi-monitor - compute bounding rectangle of all screens
                    var minX = Int.MAX_VALUE
                    var minY = Int.MAX_VALUE
                    var maxX = Int.MIN_VALUE
                    var maxY = Int.MIN_VALUE
                    devices.forEach { device ->
                        val b = device.defaultConfiguration.bounds
                        minX = minOf(minX, b.x)
                        minY = minOf(minY, b.y)
                        maxX = maxOf(maxX, b.x + b.width)
                        maxY = maxOf(maxY, b.y + b.height)
                    }
                    Rectangle(minX, minY, maxX - minX, maxY - minY)
                }
            }
        }
        validateCaptureBounds(bounds)

        // Capture image
        var image = robot.createScreenCapture(bounds)

        // Resize if exceeds API limit (2000px max dimension)
        val resizeResult = resizeIfNeeded(image)
        image = resizeResult.first
        val resizeRatio = resizeResult.second

        // Compress to JPEG
        val base64 = compressToJpegBase64(image, quality)

        // Return logical dimensions (divide by scale factor, accounting for resize)
        return ScreenshotResult(
            base64 = base64,
            width = ((bounds.width / scaleFactor) * resizeRatio).toInt(),
            height = ((bounds.height / scaleFactor) * resizeRatio).toInt(),
            scaleFactor = scaleFactor
        )
    }

    /**
     * Capture a specific rectangular region
     */
    fun captureRegion(x: Int, y: Int, width: Int, height: Int, quality: Int = 80): ScreenshotResult {
        require(quality in 1..100) { "JPEG quality must be between 1 and 100" }
        val scaleFactor = getScaleFactor()

        // Convert logical coordinates to physical
        val physicalBounds = Rectangle(
            (x * scaleFactor).toInt(),
            (y * scaleFactor).toInt(),
            (width * scaleFactor).toInt(),
            (height * scaleFactor).toInt()
        )
        validateCaptureBounds(physicalBounds)

        var image = robot.createScreenCapture(physicalBounds)

        // Resize if exceeds API limit
        val resizeResult = resizeIfNeeded(image)
        image = resizeResult.first
        val resizeRatio = resizeResult.second

        val base64 = compressToJpegBase64(image, quality)

        return ScreenshotResult(
            base64 = base64,
            width = (width * resizeRatio).toInt(),
            height = (height * resizeRatio).toInt(),
            scaleFactor = scaleFactor
        )
    }

    /**
     * Compress BufferedImage to JPEG and encode as base64
     */
    private fun compressToJpegBase64(image: BufferedImage, quality: Int): String {
        val baos = ByteArrayOutputStream()

        // Get JPEG writer
        val writers = ImageIO.getImageWritersByFormatName("jpeg")
        if (!writers.hasNext()) {
            throw RuntimeException("No JPEG writer available")
        }
        val writer = writers.next()

        // Configure compression
        val param = writer.defaultWriteParam
        if (param.canWriteCompressed()) {
            param.compressionMode = ImageWriteParam.MODE_EXPLICIT
            param.compressionQuality = quality.coerceIn(1, 100) / 100f
        }

        // Write image
        val ios = ImageIO.createImageOutputStream(baos)
        writer.output = ios
        writer.write(null, IIOImage(image, null, null), param)

        // Cleanup
        ios.close()
        writer.dispose()

        return Base64.getEncoder().encodeToString(baos.toByteArray())
    }

    /**
     * Resize image if it exceeds MAX_DIMENSION on either side
     * Returns the resized image and the resize ratio (1.0 if no resize)
     */
    private fun resizeIfNeeded(image: BufferedImage): Pair<BufferedImage, Double> {
        val width = image.width
        val height = image.height

        // Check if resize is needed
        if (width <= MAX_DIMENSION && height <= MAX_DIMENSION) {
            return Pair(image, 1.0)
        }

        // Calculate resize ratio to fit within MAX_DIMENSION
        val ratio = minOf(
            MAX_DIMENSION.toDouble() / width,
            MAX_DIMENSION.toDouble() / height
        )

        val newWidth = (width * ratio).toInt()
        val newHeight = (height * ratio).toInt()

        // Create scaled image with high quality
        val scaledImage = BufferedImage(newWidth, newHeight, BufferedImage.TYPE_INT_RGB)
        val g2d = scaledImage.createGraphics()
        g2d.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR)
        g2d.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY)
        g2d.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
        g2d.drawImage(image, 0, 0, newWidth, newHeight, null)
        g2d.dispose()

        return Pair(scaledImage, ratio)
    }

    /**
     * Get primary screen size in logical coordinates
     */
    fun getScreenSize(): Pair<Int, Int> {
        val ge = GraphicsEnvironment.getLocalGraphicsEnvironment()
        val bounds = ge.maximumWindowBounds
        val scaleFactor = getScaleFactor()

        return Pair(
            (bounds.width / scaleFactor).toInt(),
            (bounds.height / scaleFactor).toInt()
        )
    }

    /**
     * Get information about all connected monitors
     */
    fun getMonitors(): List<MonitorInfo> {
        val ge = GraphicsEnvironment.getLocalGraphicsEnvironment()
        val scaleFactor = getScaleFactor()

        return ge.screenDevices.mapIndexed { index, device ->
            val bounds = device.defaultConfiguration.bounds
            MonitorInfo(
                index = index,
                name = device.iDstring,
                x = bounds.x,
                y = bounds.y,
                width = (bounds.width / scaleFactor).toInt(),
                height = (bounds.height / scaleFactor).toInt(),
                isPrimary = device == ge.defaultScreenDevice
            )
        }
    }
}

@kotlinx.serialization.Serializable
data class MonitorInfo(
    val index: Int,
    val name: String,
    val x: Int,
    val y: Int,
    val width: Int,
    val height: Int,
    val isPrimary: Boolean
)
