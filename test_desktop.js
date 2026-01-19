import { DesktopClient } from './dist/desktop/client.js';

const client = new DesktopClient();

async function test() {
  try {
    console.log('Launching desktop companion...');
    await client.launch({});
    
    console.log('Getting window info...');
    const windowInfo = await client.getWindowInfo();
    
    console.log('Window info:', JSON.stringify(windowInfo, null, 2));
    
    await client.stop();
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

test();
