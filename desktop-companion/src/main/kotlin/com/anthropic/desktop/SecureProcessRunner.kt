package com.anthropic.desktop

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

internal data class ProcessResult(
    val exitCode: Int,
    val stdout: String,
    val stderr: String,
    val timedOut: Boolean
) {
    val succeeded: Boolean get() = !timedOut && exitCode == 0
}

/** Runs argv-only child processes with bounded output and hard deadlines. */
internal class SecureProcessRunner(
    private val maxOutputBytes: Int = 1024 * 1024
) {
    init {
        require(maxOutputBytes in 1..(50 * 1024 * 1024)) { "Output limit is out of range" }
    }
    fun run(
        command: List<String>,
        timeout: Duration,
        stdin: ByteArray? = null
    ): ProcessResult {
        require(command.isNotEmpty()) { "Command must not be empty" }
        require(!timeout.isNegative && !timeout.isZero) { "Timeout must be positive" }
        require(timeout <= Duration.ofMinutes(5)) { "Timeout exceeds 5 minutes" }
        require(command.size <= 1024) { "Command has too many arguments" }
        require(command.all { it.length <= 64 * 1024 && '\u0000' !in it }) {
            "Command argument is invalid"
        }
        require(stdin == null || stdin.size <= 1024 * 1024) { "Process input exceeds 1 MiB" }

        val process = ProcessBuilder(command).start()
        val stdout = AtomicReference(ByteArray(0))
        val stderr = AtomicReference(ByteArray(0))
        val streamFailure = AtomicReference<Throwable?>(null)
        val outputExceeded = AtomicBoolean(false)
        val stdoutThread = readerThread(process.inputStream, stdout, streamFailure, outputExceeded)
        val stderrThread = readerThread(process.errorStream, stderr, streamFailure, outputExceeded)
        val stdinThread = thread(name = "process-stdin", isDaemon = true) {
            try {
                process.outputStream.use { output ->
                    if (stdin != null) output.write(stdin)
                }
            } catch (error: Throwable) {
                if (process.isAlive) streamFailure.compareAndSet(null, error)
            }
        }

        val completed = process.waitFor(timeout.toMillis(), java.util.concurrent.TimeUnit.MILLISECONDS)
        if (!completed) {
            process.destroy()
            if (!process.waitFor(250, java.util.concurrent.TimeUnit.MILLISECONDS)) {
                process.destroyForcibly()
                if (!process.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) {
                    throw IllegalStateException("Child process did not terminate")
                }
            }
        }
        stdinThread.join(1_000)
        stdoutThread.join(1_000)
        stderrThread.join(1_000)
        streamFailure.get()?.let { throw IllegalStateException("Child process I/O failed", it) }
        if (outputExceeded.get()) throw IllegalStateException("Child process output exceeded the limit")

        return ProcessResult(
            exitCode = if (completed) process.exitValue() else -1,
            stdout = stdout.get().toString(StandardCharsets.UTF_8),
            stderr = stderr.get().toString(StandardCharsets.UTF_8),
            timedOut = !completed
        )
    }

    private fun readerThread(
        input: InputStream,
        target: AtomicReference<ByteArray>,
        failure: AtomicReference<Throwable?>,
        outputExceeded: AtomicBoolean
    ) = thread(name = "process-output", isDaemon = true) {
        try {
            input.use { stream ->
                val collected = ByteArrayOutputStream(minOf(maxOutputBytes, 8192))
                val buffer = ByteArray(8192)
                while (true) {
                    val count = stream.read(buffer)
                    if (count < 0) break
                    val remaining = maxOutputBytes - collected.size()
                    if (count > remaining) outputExceeded.set(true)
                    if (remaining > 0) collected.write(buffer, 0, minOf(count, remaining))
                }
                target.set(collected.toByteArray())
            }
        } catch (error: Throwable) {
            failure.compareAndSet(null, error)
        }
    }
}
