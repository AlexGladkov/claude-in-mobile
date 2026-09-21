package com.anthropic.desktop

import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermission
import java.time.Duration
import java.util.concurrent.ConcurrentHashMap

/** Compiles bundled Swift helpers only inside a random, owner-only directory. */
internal object SwiftHelperManager {
    private val runner = SecureProcessRunner()
    private val helpers = ConcurrentHashMap<String, Path>()
    private val root: Path by lazy {
        Files.createTempDirectory("mcp-devices-swift-").also { directory ->
            setPermissions(
                directory,
                setOf(
                    PosixFilePermission.OWNER_READ,
                    PosixFilePermission.OWNER_WRITE,
                    PosixFilePermission.OWNER_EXECUTE
                )
            )
            directory.toFile().deleteOnExit()
        }
    }

    fun compileResource(owner: Class<*>, resource: String, name: String): Path? {
        val source = owner.getResourceAsStream(resource)?.use {
            it.readBytes().toString(StandardCharsets.UTF_8)
        } ?: return null
        return compileSource(source, name)
    }

    fun compileSource(source: String, name: String): Path? {
        require(name.matches(Regex("[A-Za-z0-9_-]{1,64}"))) { "Invalid Swift helper name" }
        helpers[name]?.takeIf(Files::isRegularFile)?.let { return it }
        return synchronized(this) {
            helpers[name]?.takeIf(Files::isRegularFile)?.let { return@synchronized it }
            val sourcePath = root.resolve("$name.swift")
            val binaryPath = root.resolve(name)
            Files.writeString(sourcePath, source, StandardCharsets.UTF_8)
            setPermissions(
                sourcePath,
                setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE)
            )
            sourcePath.toFile().deleteOnExit()
            binaryPath.toFile().deleteOnExit()

            val result = runner.run(
                listOf("swiftc", "-O", "-o", binaryPath.toString(), sourcePath.toString()),
                Duration.ofSeconds(60)
            )
            Files.deleteIfExists(sourcePath)
            if (!result.succeeded || !Files.isRegularFile(binaryPath)) {
                Files.deleteIfExists(binaryPath)
                return@synchronized null
            }
            helpers[name] = binaryPath
            binaryPath
        }
    }

    private fun setPermissions(path: Path, permissions: Set<PosixFilePermission>) {
        try {
            Files.setPosixFilePermissions(path, permissions)
        } catch (_: UnsupportedOperationException) {
            // Windows ACLs are inherited from the current user's temporary directory.
        }
    }
}
