package com.anthropic.desktop

import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import kotlinx.coroutines.sync.Semaphore
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.PrintWriter

/**
 * JSON-RPC server that communicates via stdin/stdout
 */
class JsonRpcServer(
    private val inputStream: java.io.InputStream = System.`in`,
    private val outputStream: java.io.OutputStream = System.out
) {
    @PublishedApi
    internal val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    @PublishedApi
    internal val handlers = mutableMapOf<String, suspend (JsonElement?) -> JsonElement>()
    private val writer = PrintWriter(outputStream, true)
    private val requestSlots = Semaphore(16)

    companion object {
        private const val MAX_REQUEST_CHARS = 1024 * 1024
        private const val MAX_JSON_DEPTH = 64
        private const val MAX_METHOD_CHARS = 128
    }

    /**
     * Register a handler for a method
     */
    fun registerHandler(method: String, handler: suspend (JsonElement?) -> JsonElement) {
        handlers[method] = handler
    }

    /**
     * Register a handler that returns a serializable object
     */
    inline fun <reified T> registerTypedHandler(
        method: String,
        crossinline handler: suspend (JsonElement?) -> T
    ) {
        handlers[method] = { params ->
            val result = handler(params)
            json.encodeToJsonElement(result)
        }
    }

    /**
     * Register a handler that returns Unit (void)
     */
    fun registerVoidHandler(method: String, handler: suspend (JsonElement?) -> Unit) {
        handlers[method] = { params ->
            handler(params)
            JsonNull
        }
    }

    /**
     * Send response to stdout
     */
    private fun sendResponse(response: JsonRpcResponse) {
        val jsonString = json.encodeToString(response)
        synchronized(writer) {
            writer.println(jsonString)
            writer.flush()
        }
    }

    /**
     * Send error response
     */
    private fun sendError(id: Int, code: Int, message: String, data: JsonElement? = null) {
        sendResponse(
            JsonRpcResponse(
                id = id,
                error = JsonRpcError(code, message, data)
            )
        )
    }

    /**
     * Process a single request
     */
    private suspend fun processRequest(request: JsonRpcRequest) {
        val handler = handlers[request.method]

        if (handler == null) {
            sendError(request.id, -32601, "Method not found")
            return
        }

        try {
            val result = handler(request.params)
            sendResponse(
                JsonRpcResponse(
                    id = request.id,
                    result = result
                )
            )
        } catch (_: Exception) {
            sendError(request.id, -32603, "Internal error")
        }
    }

    /**
     * Start the server (blocking stdin read, async request processing)
     */
    suspend fun start() = coroutineScope {
        // Signal that we're ready
        System.err.println("Desktop companion ready")

        val reader = BufferedReader(InputStreamReader(inputStream))

        while (true) {
            val line = try {
                readBoundedLine(reader) ?: break
            } catch (_: RequestTooLargeException) {
                sendError(0, -32600, "Request exceeds the 1 MiB limit")
                continue
            }
            if (line.isBlank()) continue
            if (exceedsJsonNestingLimit(line)) {
                sendError(0, -32600, "Request exceeds the JSON nesting limit")
                continue
            }

            try {
                val request = json.decodeFromString<JsonRpcRequest>(line)
                if (request.jsonrpc != "2.0" ||
                    request.method.isEmpty() ||
                    request.method.length > MAX_METHOD_CHARS ||
                    request.method.any { !it.isLetterOrDigit() && it != '_' && it != '.' && it != '-' }
                ) {
                    sendError(request.id, -32600, "Invalid Request")
                    continue
                }
                requestSlots.acquire()
                launch(Dispatchers.IO) {
                    try {
                        processRequest(request)
                    } catch (_: Exception) {
                        sendError(request.id, -32603, "Internal error")
                    } finally {
                        requestSlots.release()
                    }
                }
            } catch (_: Exception) {
                sendError(0, -32700, "Parse error")
            }
        }
    }


    private fun exceedsJsonNestingLimit(input: String): Boolean {
        var depth = 0
        var inString = false
        var escaped = false
        for (character in input) {
            if (inString) {
                if (escaped) {
                    escaped = false
                } else if (character == '\\') {
                    escaped = true
                } else if (character == '"') {
                    inString = false
                }
                continue
            }
            when (character) {
                '"' -> inString = true
                '{', '[' -> {
                    depth++
                    if (depth > MAX_JSON_DEPTH) return true
                }
                '}', ']' -> depth--
            }
        }
        return false
    }

    private fun readBoundedLine(reader: BufferedReader): String? {
        val line = StringBuilder()
        while (true) {
            val value = reader.read()
            if (value == -1) return if (line.isEmpty()) null else line.toString()
            if (value == '\n'.code) return line.toString().removeSuffix("\r")
            if (line.length >= MAX_REQUEST_CHARS) {
                while (true) {
                    val remainder = reader.read()
                    if (remainder == -1 || remainder == '\n'.code) break
                }
                throw RequestTooLargeException()
            }
            line.append(value.toChar())
        }
    }

    private class RequestTooLargeException : RuntimeException()

    /**
     * Stop the server
     */
    fun stop() {
        writer.close()
    }
}

/**
 * Extension functions for parameter extraction
 */
fun JsonElement?.int(key: String): Int? =
    (this as? JsonObject)?.get(key)?.jsonPrimitive?.intOrNull

fun JsonElement?.intOrThrow(key: String): Int =
    int(key) ?: throw IllegalArgumentException("Missing required parameter: $key")

fun JsonElement?.long(key: String): Long? =
    (this as? JsonObject)?.get(key)?.jsonPrimitive?.longOrNull

fun JsonElement?.double(key: String): Double? =
    (this as? JsonObject)?.get(key)?.jsonPrimitive?.doubleOrNull

fun JsonElement?.string(key: String): String? =
    (this as? JsonObject)?.get(key)?.jsonPrimitive?.contentOrNull

fun JsonElement?.stringOrThrow(key: String): String =
    string(key) ?: throw IllegalArgumentException("Missing required parameter: $key")

fun JsonElement?.boolean(key: String): Boolean? =
    (this as? JsonObject)?.get(key)?.jsonPrimitive?.booleanOrNull

fun JsonElement?.stringList(key: String): List<String>? =
    (this as? JsonObject)?.get(key)?.jsonArray?.map { it.jsonPrimitive.content }
