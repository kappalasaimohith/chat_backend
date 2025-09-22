import WebSocket from 'ws';

// Test WebSocket connection
async function testWebSocket() {
  console.log('🧪 Testing WebSocket connection...');
  
  // This is a test token - in real usage, you'd get this from Supabase auth
  const testToken = 'test_token_123';
  const wsUrl = `ws://localhost:5000/ws?token=${testToken}`;
  
  console.log(`Connecting to: ${wsUrl}`);
  
  const ws = new WebSocket(wsUrl);
  
  ws.on('open', () => {
    console.log('✅ WebSocket connected successfully!');
    
    // Test sending a message
    const testMessage = {
      type: 'join',
      chat_id: 'test-chat-123'
    };
    
    console.log('📤 Sending test message:', testMessage);
    ws.send(JSON.stringify(testMessage));
    
    // Close after 5 seconds
    setTimeout(() => {
      console.log('🔌 Closing test connection...');
      ws.close();
    }, 5000);
  });
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      console.log('📥 Received message:', message);
    } catch (error) {
      console.log('📥 Received raw data:', data.toString());
    }
  });
  
  ws.on('close', (code, reason) => {
    console.log(`🔌 WebSocket closed: ${code} - ${reason}`);
  });
  
  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
  });
  
  // Timeout after 10 seconds
  setTimeout(() => {
    if (ws.readyState === WebSocket.CONNECTING) {
      console.error('⏰ Connection timeout');
      ws.close();
    }
  }, 10000);
}

// Run the test
testWebSocket().catch(console.error);
