package com.anthropic.desktop

import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
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
            sendError(request.id, -32601, "Method not found: ${request.method}")
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
        } catch (e: Exception) {
            sendError(request.id, -32603, e.message ?: "Internal error")
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
            val line = reader.readLine() ?: break

            if (line.isBlank()) continue

            try {
                val request = json.decodeFromString<JsonRpcRequest>(line)
                // Launch request processing in separate coroutine
                // This prevents slow handlers (like AppleScript) from blocking stdin read
                launch {
                    try {
                        processRequest(request)
                    } catch (e: Exception) {
                        System.err.println("Request processing error: ${e.message}")
                        sendError(request.id, -32603, "Internal error: ${e.message}")
                    }
                }
            } catch (e: Exception) {
                // Parse error
                sendError(0, -32700, "Parse error: ${e.message}")
            }
        }
    }

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
