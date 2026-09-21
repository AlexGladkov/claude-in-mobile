import Cocoa
import ApplicationServices

// AXClick - Click elements by text using Accessibility API (no cursor movement)
// Usage: ax_click <pid> [--exact], with target text on stdin

guard CommandLine.arguments.count >= 2 else {
    fputs("Usage: ax_click <pid> [--exact]\n", stderr)
    exit(1)
}

let pid = pid_t(CommandLine.arguments[1]) ?? 0
let textData = FileHandle.standardInput.readDataToEndOfFile()
guard textData.count <= 1_048_576,
      let targetText = String(data: textData, encoding: .utf8) else {
    fputs("Invalid or oversized UTF-8 input\n", stderr)
    exit(1)
}
let exactMatch = CommandLine.arguments.contains("--exact")

guard pid > 0 else {
    fputs("Error: Invalid PID\n", stderr)
    exit(1)
}

let appElement = AXUIElementCreateApplication(pid)

// Check if we can access the app
var appRole: CFTypeRef?
let roleResult = AXUIElementCopyAttributeValue(appElement, kAXRoleAttribute as CFString, &appRole)
guard roleResult == .success else {
    fputs("Error: Cannot access app (code: \(roleResult.rawValue)). Check accessibility permissions.\n", stderr)
    exit(2)
}

// Get windows
var windows: CFTypeRef?
AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windows)

guard let windowArray = windows as? [AXUIElement], !windowArray.isEmpty else {
    fputs("Error: No windows found for PID \(pid)\n", stderr)
    exit(3)
}

// Search for element with matching text
func findElement(withText text: String, in element: AXUIElement, depth: Int = 0) -> AXUIElement? {
    if depth > 15 { return nil }

    // Check title
    var title: CFTypeRef?
    AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &title)
    if let titleStr = title as? String {
        if exactMatch ? titleStr == text : titleStr.localizedCaseInsensitiveContains(text) {
            return element
        }
    }

    // Check value
    var value: CFTypeRef?
    AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value)
    if let valueStr = value as? String {
        if exactMatch ? valueStr == text : valueStr.localizedCaseInsensitiveContains(text) {
            return element
        }
    }

    // Check description
    var desc: CFTypeRef?
    AXUIElementCopyAttributeValue(element, kAXDescriptionAttribute as CFString, &desc)
    if let descStr = desc as? String {
        if exactMatch ? descStr == text : descStr.localizedCaseInsensitiveContains(text) {
            return element
        }
    }

    // Check help text
    var help: CFTypeRef?
    AXUIElementCopyAttributeValue(element, kAXHelpAttribute as CFString, &help)
    if let helpStr = help as? String {
        if exactMatch ? helpStr == text : helpStr.localizedCaseInsensitiveContains(text) {
            return element
        }
    }

    // Recurse into children
    var children: CFTypeRef?
    AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children)

    if let childArray = children as? [AXUIElement] {
        for child in childArray {
            if let found = findElement(withText: text, in: child, depth: depth + 1) {
                return found
            }
        }
    }

    return nil
}

// Try to perform press action
func tryPress(_ element: AXUIElement) -> Bool {
    // First try AXPress
    if AXUIElementPerformAction(element, kAXPressAction as CFString) == .success {
        return true
    }

    // Try AXConfirm (for some button types)
    if AXUIElementPerformAction(element, kAXConfirmAction as CFString) == .success {
        return true
    }

    // Try clicking parent if this is static text inside a button
    var parent: CFTypeRef?
    AXUIElementCopyAttributeValue(element, kAXParentAttribute as CFString, &parent)
    if let parentElement = parent as! AXUIElement? {
        var parentRole: CFTypeRef?
        AXUIElementCopyAttributeValue(parentElement, kAXRoleAttribute as CFString, &parentRole)
        if let role = parentRole as? String, role == "AXButton" || role == "AXLink" {
            if AXUIElementPerformAction(parentElement, kAXPressAction as CFString) == .success {
                return true
            }
        }
    }

    return false
}

// Search in all windows
var found = false
var foundElement: AXUIElement?
var foundRole: String = ""

for window in windowArray {
    if let element = findElement(withText: targetText, in: window) {
        foundElement = element

        var role: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role)
        foundRole = role as? String ?? "unknown"

        if tryPress(element) {
            found = true
            print("OK:pressed:\(foundRole)")
            break
        }
    }
}

if !found {
    if let element = foundElement {
        // Found element but couldn't press it
        fputs("Error: Found element (\(foundRole)) but press action failed\n", stderr)
        exit(4)
    } else {
        fputs("Error: Element with text '\(targetText)' not found\n", stderr)
        exit(5)
    }
}

exit(0)
