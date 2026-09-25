package com.anthropic.desktop

import com.anthropic.desktop.accessibility.MacOSAccessibility
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class MacOSAccessibilityTest {
    @Test
    fun `parses secure marker while preserving labels and geometry`() {
        val elements = parseAppleScriptElements(
            "{{AXSecureTextField,Password title,Password description,12,34,56,78,true,false,true}," +
                "{AXTextField,Email title,Email description,-5,6,70,80,false,true,false}}"
        )

        val secure = elements[0]
        assertTrue(secure.password)
        assertEquals("Password title", secure.text)
        assertEquals("Password description", secure.contentDescription)
        assertEquals(Bounds(12, 34, 56, 78), secure.bounds)
        assertTrue(secure.enabled)
        assertFalse(secure.focused)

        val regular = elements[1]
        assertFalse(regular.password)
        assertEquals("Email title", regular.text)
        assertEquals("Email description", regular.contentDescription)
        assertEquals(Bounds(-5, 6, 70, 80), regular.bounds)
        assertFalse(regular.enabled)
        assertTrue(regular.focused)
    }

    private fun parseAppleScriptElements(output: String): List<UiElement> {
        val elements = mutableListOf<UiElement>()
        val parser = MacOSAccessibility::class.java.getDeclaredMethod(
            "parseAppleScriptElements",
            String::class.java,
            MutableList::class.java
        )
        parser.isAccessible = true
        parser.invoke(MacOSAccessibility(), output, elements)
        return elements
    }
}
