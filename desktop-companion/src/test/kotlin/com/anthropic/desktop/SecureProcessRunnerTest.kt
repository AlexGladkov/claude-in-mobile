package com.anthropic.desktop

import java.time.Duration
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class SecureProcessRunnerTest {
    @Test
    fun `rejects child process output beyond configured limit`() {
        assertFailsWith<IllegalStateException> {
            SecureProcessRunner(maxOutputBytes = 32).run(
                listOf("/bin/sh", "-c", "printf '%0100d' 0"),
                Duration.ofSeconds(2)
            )
        }
    }

    @Test
    fun `terminates child process at deadline`() {
        val result = SecureProcessRunner().run(
            listOf("/bin/sh", "-c", "sleep 5"),
            Duration.ofMillis(50)
        )

        assertTrue(result.timedOut)
        assertEquals(-1, result.exitCode)
    }
}
