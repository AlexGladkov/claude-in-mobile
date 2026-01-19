import { spawn } from 'child_process';

const companionPath = '/Users/neuradev/Documents/QuickTools/claude-in-android/desktop-companion/build/install/desktop-companion/bin/desktop-companion';

const proc = spawn(companionPath, [], {
  stdio: ['pipe', 'pipe', 'pipe']
});

const stderrLogs = [];
const stdoutLogs = [];

proc.stderr.on('data', (data) => {
  const message = data.toString();
  stderrLogs.push(message);
  console.error('[STDERR]', message);
});

proc.stdout.on('data', (data) => {
  const message = data.toString();
  stdoutLogs.push(message);
  console.log('[STDOUT]', message);
});

proc.on('exit', (code) => {
  console.log('[EXIT]', code);
  console.log('\n=== SUMMARY ===');
  console.log('Total STDERR messages:', stderrLogs.length);
  console.log('Total STDOUT messages:', stdoutLogs.length);
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

// Kill after 35 seconds (just before timeout)
setTimeout(() => {
  console.log('[KILL] Timeout, killing process...');
  proc.kill();
}, 35000);
