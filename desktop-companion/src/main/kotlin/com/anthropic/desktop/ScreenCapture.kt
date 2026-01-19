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

/**
 * Handles screen capture with JPEG compression and HiDPI support
 */
class ScreenCapture {
    private val robot = Robot()

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
        val ge = GraphicsEnvironment.getLocalGraphicsEnvironment()
        val scaleFactor = getScaleFactor()

        // Determine capture bounds
        val bounds = if (windowId != null) {
            WindowManager().getWindowBounds(windowId)
        } else {
            // Multi-monitor support
            val devices = ge.screenDevices
            when {
                monitorIndex != null && monitorIndex < devices.size -> {
                    // Capture specific monitor
                    devices[monitorIndex].defaultConfiguration.bounds
                }
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

        // Capture image
        val image = robot.createScreenCapture(bounds)

        // Compress to JPEG
        val base64 = compressToJpegBase64(image, quality)

        // Return logical dimensions (divide by scale factor)
        return ScreenshotResult(
            base64 = base64,
            width = (bounds.width / scaleFactor).toInt(),
            height = (bounds.height / scaleFactor).toInt(),
            scaleFactor = scaleFactor
        )
    }

    /**
     * Capture a specific rectangular region
     */
    fun captureRegion(x: Int, y: Int, width: Int, height: Int, quality: Int = 80): ScreenshotResult {
        val scaleFactor = getScaleFactor()

        // Convert logical coordinates to physical
        val physicalBounds = Rectangle(
            (x * scaleFactor).toInt(),
            (y * scaleFactor).toInt(),
            (width * scaleFactor).toInt(),
            (height * scaleFactor).toInt()
        )

        val image = robot.createScreenCapture(physicalBounds)
        val base64 = compressToJpegBase64(image, quality)

        return ScreenshotResult(
            base64 = base64,
            width = width,
            height = height,
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
