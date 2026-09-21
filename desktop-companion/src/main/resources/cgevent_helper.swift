import Cocoa
import Foundation

// CGEvent helper for sending events to specific processes without stealing focus
// Usage: cgevent_helper <command> <args...>
//
// Commands:
//   type <pid>                  - Read text from stdin and type it to the process
//   key <pid> <keycode> [mods]  - Send key event (mods: shift,ctrl,alt,cmd)
//   click <pid> <x> <y>         - Click at coordinates in process window
//   mousedown <pid> <x> <y>     - Mouse down at coordinates
//   mouseup <pid> <x> <y>       - Mouse up at coordinates

guard CommandLine.arguments.count >= 3 else {
    fputs("Usage: cgevent_helper <command> <pid> <args...>\n", stderr)
    exit(1)
}

let command = CommandLine.arguments[1]
guard let pid = Int32(CommandLine.arguments[2]) else {
    fputs("Invalid PID: \(CommandLine.arguments[2])\n", stderr)
    exit(1)
}

// Helper to create CGEventSource
func createEventSource() -> CGEventSource? {
    return CGEventSource(stateID: .hidSystemState)
}

// Send keyboard event to PID
func sendKeyToPid(pid: Int32, keyCode: CGKeyCode, keyDown: Bool, flags: CGEventFlags = []) {
    guard let source = createEventSource() else {
        fputs("Failed to create event source\n", stderr)
        return
    }

    guard let event = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: keyDown) else {
        fputs("Failed to create keyboard event\n", stderr)
        return
    }

    event.flags = flags
    event.postToPid(pid)
}

// Type a character
func typeChar(pid: Int32, char: Character) {
    guard let source = createEventSource() else { return }

    // Get the key code and shift state for this character
    let (keyCode, needsShift) = keyCodeForChar(char)

    if keyCode == 0xFFFF {
        // Use Unicode input for characters without direct key codes
        typeUnicode(pid: pid, char: char)
        return
    }

    var flags: CGEventFlags = []
    if needsShift {
        flags.insert(.maskShift)
    }

    // Key down
    sendKeyToPid(pid: pid, keyCode: keyCode, keyDown: true, flags: flags)
    usleep(5000) // 5ms delay

    // Key up
    sendKeyToPid(pid: pid, keyCode: keyCode, keyDown: false, flags: flags)
    usleep(5000)
}

// Type using Unicode input method
func typeUnicode(pid: Int32, char: Character) {
    guard let source = createEventSource() else { return }

    let str = String(char)
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true) else { return }

    var unicodeChars = Array(str.utf16)
    event.keyboardSetUnicodeString(stringLength: unicodeChars.count, unicodeString: &unicodeChars)
    event.postToPid(pid)

    // Key up
    if let upEvent = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) {
        upEvent.postToPid(pid)
    }
}

// Get key code for character
func keyCodeForChar(_ char: Character) -> (CGKeyCode, Bool) {
    let charLower = char.lowercased().first ?? char
    let needsShift = char.isUppercase || "~!@#$%^&*()_+{}|:\"<>?".contains(char)

    // Key code mapping (US keyboard layout)
    let keyMap: [Character: CGKeyCode] = [
        "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4,
        "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35,
        "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7,
        "y": 16, "z": 6,
        "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28,
        "9": 25, "0": 29,
        " ": 49, "\t": 48, "\n": 36, "\r": 36,
        "-": 27, "=": 24, "[": 33, "]": 30, "\\": 42, ";": 41, "'": 39,
        ",": 43, ".": 47, "/": 44, "`": 50
    ]

    // Shift variants
    let shiftMap: [Character: CGKeyCode] = [
        "!": 18, "@": 19, "#": 20, "$": 21, "%": 23, "^": 22, "&": 26, "*": 28,
        "(": 25, ")": 29, "_": 27, "+": 24, "{": 33, "}": 30, "|": 42,
        ":": 41, "\"": 39, "<": 43, ">": 47, "?": 44, "~": 50
    ]

    if let keyCode = keyMap[charLower] {
        return (keyCode, needsShift)
    }

    if let keyCode = shiftMap[char] {
        return (keyCode, true)
    }

    // Unknown character - use Unicode
    return (0xFFFF, false)
}

// Send mouse event to coordinates
func sendMouseEvent(pid: Int32, x: CGFloat, y: CGFloat, eventType: CGEventType, button: CGMouseButton = .left) {
    guard let source = createEventSource() else {
        fputs("Failed to create event source\n", stderr)
        return
    }

    let point = CGPoint(x: x, y: y)
    guard let event = CGEvent(mouseEventSource: source, mouseType: eventType, mouseCursorPosition: point, mouseButton: button) else {
        fputs("Failed to create mouse event\n", stderr)
        return
    }

    event.postToPid(pid)
}

// Main command handling
switch command {
case "type":
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard data.count <= 1_048_576, let text = String(data: data, encoding: .utf8) else {
        fputs("Invalid or oversized UTF-8 input\n", stderr)
        exit(1)
    }
    for char in text {
        typeChar(pid: pid, char: char)
        usleep(10000) // 10ms between characters
    }

case "key":
    guard CommandLine.arguments.count >= 4 else {
        fputs("Usage: cgevent_helper key <pid> <keycode> [mods]\n", stderr)
        exit(1)
    }
    guard let keyCode = UInt16(CommandLine.arguments[3]) else {
        fputs("Invalid keycode\n", stderr)
        exit(1)
    }

    var flags: CGEventFlags = []
    if CommandLine.arguments.count >= 5 {
        let mods = CommandLine.arguments[4].lowercased()
        if mods.contains("shift") { flags.insert(.maskShift) }
        if mods.contains("ctrl") || mods.contains("control") { flags.insert(.maskControl) }
        if mods.contains("alt") || mods.contains("option") { flags.insert(.maskAlternate) }
        if mods.contains("cmd") || mods.contains("command") { flags.insert(.maskCommand) }
    }

    sendKeyToPid(pid: pid, keyCode: CGKeyCode(keyCode), keyDown: true, flags: flags)
    usleep(10000)
    sendKeyToPid(pid: pid, keyCode: CGKeyCode(keyCode), keyDown: false, flags: flags)

case "click":
    guard CommandLine.arguments.count >= 5 else {
        fputs("Usage: cgevent_helper click <pid> <x> <y>\n", stderr)
        exit(1)
    }
    guard let x = Double(CommandLine.arguments[3]), let y = Double(CommandLine.arguments[4]) else {
        fputs("Invalid coordinates\n", stderr)
        exit(1)
    }

    // Mouse down, then up for click
    sendMouseEvent(pid: pid, x: CGFloat(x), y: CGFloat(y), eventType: .leftMouseDown)
    usleep(50000) // 50ms
    sendMouseEvent(pid: pid, x: CGFloat(x), y: CGFloat(y), eventType: .leftMouseUp)

case "mousedown":
    guard CommandLine.arguments.count >= 5 else {
        fputs("Usage: cgevent_helper mousedown <pid> <x> <y>\n", stderr)
        exit(1)
    }
    guard let x = Double(CommandLine.arguments[3]), let y = Double(CommandLine.arguments[4]) else {
        fputs("Invalid coordinates\n", stderr)
        exit(1)
    }
    sendMouseEvent(pid: pid, x: CGFloat(x), y: CGFloat(y), eventType: .leftMouseDown)

case "mouseup":
    guard CommandLine.arguments.count >= 5 else {
        fputs("Usage: cgevent_helper mouseup <pid> <x> <y>\n", stderr)
        exit(1)
    }
    guard let x = Double(CommandLine.arguments[3]), let y = Double(CommandLine.arguments[4]) else {
        fputs("Invalid coordinates\n", stderr)
        exit(1)
    }
    sendMouseEvent(pid: pid, x: CGFloat(x), y: CGFloat(y), eventType: .leftMouseUp)

default:
    fputs("Unknown command: \(command)\n", stderr)
    exit(1)
}
