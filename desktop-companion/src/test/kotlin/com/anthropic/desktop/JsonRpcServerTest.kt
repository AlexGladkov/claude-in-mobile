package com.anthropic.desktop

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertFalse

class JsonRpcServerTest {
    @Test
    fun `rejects oversized request before parsing`() = runBlocking {
        val input = ByteArrayInputStream(("x".repeat(1024 * 1024 + 1) + "\n").toByteArray())
        val output = ByteArrayOutputStream()

        JsonRpcServer(input, output).start()

        assertContains(output.toString(), "\"code\":-32600")
    }

    @Test
    fun `does not reflect unknown method names`() = runBlocking {
        val secret = "unknown-secret-bearing-method"
        val request = """{"jsonrpc":"2.0","id":7,"method":"$secret"}"""
        val output = ByteArrayOutputStream()

        JsonRpcServer(ByteArrayInputStream("$request\n".toByteArray()), output).start()

        assertContains(output.toString(), "\"code\":-32601")
        assertFalse(output.toString().contains(secret))
    }

    @Test
    fun `rejects invalid protocol version before dispatch`() = runBlocking {
        val request = """{"jsonrpc":"1.0","id":9,"method":"ping"}"""
        val output = ByteArrayOutputStream()

        JsonRpcServer(ByteArrayInputStream("$request\n".toByteArray()), output).start()

        assertContains(output.toString(), "\"code\":-32600")
    }

    @Test
    fun `rejects excessive JSON nesting before deserialization`() = runBlocking {
        val nested = "[".repeat(65) + "0" + "]".repeat(65)
        val request = """{"jsonrpc":"2.0","id":11,"method":"ping","params":$nested}"""
        val output = ByteArrayOutputStream()

        JsonRpcServer(ByteArrayInputStream("$request\n".toByteArray()), output).start()

        assertContains(output.toString(), "\"code\":-32600")
    }
}
