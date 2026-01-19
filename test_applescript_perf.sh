#!/bin/bash

echo "Testing AppleScript performance..."
time osascript -e 'tell application "System Events"
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
end tell' > /dev/null
