import java.io.BufferedReader
import java.io.InputStreamReader

fun main() {
    println("Testing AppleScript from Kotlin...")
    
    val script = """
        tell application "System Events"
            set windowList to {}
            repeat with proc in processes
                set procName to name of proc
                try
                    if (count of windows of proc) > 0 then
                        repeat with win in windows of proc
                            try
                                if exists (position of win) then
                                    set winName to name of win
                                    set winPos to position of win
                                    set winSize to size of win
                                    if (item 1 of winSize) > 0 and (item 2 of winSize) > 0 then
                                        set end of windowList to {procName, winName, item 1 of winPos, item 2 of winPos, item 1 of winSize, item 2 of winSize}
                                    end if
                                end if
                            end try
                        end repeat
                    end if
                end try
            end repeat
            return windowList
        end tell
    """.trimIndent()
    
    val startTime = System.currentTimeMillis()
    val process = ProcessBuilder("osascript", "-e", script).start()
    val output = process.inputStream.bufferedReader().readText()
    val exitCode = process.waitFor()
    val elapsed = System.currentTimeMillis() - startTime
    
    println("Exit code: $exitCode")
    println("Elapsed: ${elapsed}ms")
    println("Output length: ${output.length}")
    println("First 200 chars: ${output.take(200)}")
}
