import { spawn } from 'child_process';

const companionPath = '/Users/neuradev/Documents/QuickTools/claude-in-android/desktop-companion/build/install/desktop-companion/bin/desktop-companion';

const proc = spawn(companionPath, [], {
  stdio: ['pipe', 'pipe', 'pipe']
});

proc.stderr.on('data', (data) => {
  console.error('[STDERR]', data.toString());
});

proc.stdout.on('data', (data) => {
  console.log('[STDOUT]', data.toString());
});

proc.on('exit', (code) => {
  console.log('[EXIT]', code);
});

// Wait for ready, then send request
setTimeout(() => {
  console.log('[SEND] Sending get_window_info request...');
  const request = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "get_window_info"
  });
  proc.stdin.write(request + '\n');
}, 2000);

// Kill after 10 seconds
setTimeout(() => {
  console.log('[KILL] Timeout, killing process...');
  proc.kill();
}, 10000);
