import Cocoa

// Returns Simulator window geometry: x,y,w,h
// Uses CGWindowListCopyWindowInfo — no TCC/Accessibility permission required.
// Works in ad-hoc signed terminals (Cursor, VibeStudio, etc.)

guard let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
    fputs("ERROR: CGWindowListCopyWindowInfo returned nil\n", stderr)
    exit(1)
}

for window in windowList {
    guard let ownerName = window[kCGWindowOwnerName as String] as? String,
          ownerName == "Simulator",
          let layer = window[kCGWindowLayer as String] as? Int,
          layer == 0,
          let bounds = window[kCGWindowBounds as String] as? [String: CGFloat] else {
        continue
    }

    let x = bounds["X"] ?? 0
    let y = bounds["Y"] ?? 0
    let w = bounds["Width"] ?? 0
    let h = bounds["Height"] ?? 0

    print("\(Int(x)),\(Int(y)),\(Int(w)),\(Int(h))")
    exit(0)
}

fputs("ERROR: No Simulator window found on screen\n", stderr)
exit(1)
