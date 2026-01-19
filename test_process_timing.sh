#!/bin/bash

echo "Testing per-process timing..."

osascript << 'APPLESCRIPT'
tell application "System Events"
    repeat with proc in processes
        set procName to name of proc
        set startTime to (current date)
        try
            set windowCount to count of windows of proc
            if windowCount > 0 then
                repeat with win in windows of proc
                    try
                        if exists (position of win) then
                            -- Just checking existence
                        end if
                    end try
                end repeat
            end if
            set endTime to (current date)
            set elapsed to endTime - startTime
            if elapsed > 1 then
                log "SLOW: " & procName & " took " & elapsed & " seconds"
            end if
        on error errMsg
            log "ERROR in " & procName & ": " & errMsg
        end try
    end repeat
end tell
APPLESCRIPT
