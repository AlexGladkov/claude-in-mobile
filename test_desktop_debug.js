import { DesktopClient } from './dist/desktop/client.js';

const client = new DesktopClient();

// Listen to logs
client.on('ready', () => {
  console.log('[EVENT] Desktop companion ready');
});

async function test() {
  try {
    console.log('[TEST] Launching desktop companion...');
    await client.launch({});
    
    console.log('[TEST] Companion launched, state:', client.getState());
    
    // Get logs before making the request
    console.log('[TEST] Logs before request:', client.getLogs());
    
    console.log('[TEST] Getting window info...');
    const windowInfo = await client.getWindowInfo();
    
    console.log('[TEST] Window info:', JSON.stringify(windowInfo, null, 2));
    
    await client.stop();
  } catch (error) {
    console.error('[TEST] Error:', error.message);
    console.error('[TEST] Final logs:', client.getLogs());
    console.error('[TEST] Final state:', client.getState());
    process.exit(1);
  }
}

test();
