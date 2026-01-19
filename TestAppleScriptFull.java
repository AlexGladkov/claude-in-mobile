import java.io.BufferedReader;
import java.io.InputStreamReader;

public class TestAppleScriptFull {
    public static void main(String[] args) throws Exception {
        System.out.println("Testing AppleScript from Java with stderr...");
        
        String script = """
            tell application "System Events"
                set windowList to {}
                repeat with proc in first 5 processes
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
            """;
        
        ProcessBuilder pb = new ProcessBuilder("osascript", "-e", script);
        Process process = pb.start();
        
        // Read stdout
        BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()));
        StringBuilder output = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) {
            output.append(line).append("\n");
        }
        
        // Read stderr
        BufferedReader errReader = new BufferedReader(new InputStreamReader(process.getErrorStream()));
        StringBuilder errOutput = new StringBuilder();
        while ((line = errReader.readLine()) != null) {
            errOutput.append(line).append("\n");
        }
        
        int exitCode = process.waitFor();
        
        System.out.println("Exit code: " + exitCode);
        System.out.println("=== STDOUT ===");
        System.out.println(output);
        System.out.println("=== STDERR ===");
        System.out.println(errOutput);
    }
}
