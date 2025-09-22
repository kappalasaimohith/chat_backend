import WebSocket from 'ws';

// Test WebSocket messaging functionality
async function testMessaging() {
  console.log('🧪 Testing WebSocket messaging functionality...');
  
  // This is a test token - in real usage, you'd get this from Supabase auth
  const testToken = 'test_token_123';
  const wsUrl = `ws://localhost:5000/ws?token=${testToken}`;
  
  console.log(`Connecting to: ${wsUrl}`);
  
  const ws = new WebSocket(wsUrl);
  
  ws.on('open', () => {
    console.log('✅ WebSocket connected successfully!');
    
    // Test 1: Join a chat room
    console.log('\n📤 Test 1: Joining chat room...');
    const joinMessage = {
      type: 'join',
      chat_id: 'test-chat-123'
    };
    ws.send(JSON.stringify(joinMessage));
    
    // Test 2: Send a message after a short delay
    setTimeout(() => {
      console.log('\n📤 Test 2: Sending message...');
      const messageData = {
        type: 'new_message',
        chat_id: 'test-chat-123',
        content: 'Hello, this is a test message!'
      };
      ws.send(JSON.stringify(messageData));
    }, 1000);
    
    // Test 3: Get chat status
    setTimeout(() => {
      console.log('\n📤 Test 3: Getting chat status...');
      const statusMessage = {
        type: 'get_chat_status',
        chat_id: 'test-chat-123'
      };
      ws.send(JSON.stringify(statusMessage));
    }, 2000);
    
    // Test 4: Get debug info
    setTimeout(() => {
      console.log('\n📤 Test 4: Getting debug info...');
      const debugMessage = {
        type: 'debug_info'
      };
      ws.send(JSON.stringify(debugMessage));
    }, 3000);
    
    // Test 5: Send ping
    setTimeout(() => {
      console.log('\n📤 Test 5: Sending ping...');
      const pingMessage = {
        type: 'ping'
      };
      ws.send(JSON.stringify(pingMessage));
    }, 4000);
    
    // Close after 6 seconds
    setTimeout(() => {
      console.log('\n🔌 Closing test connection...');
      ws.close();
    }, 6000);
  });
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      console.log('📥 Received message:', message);
      
      // Handle specific message types
      switch (message.type) {
        case 'joined_chat':
          console.log('✅ Successfully joined chat room');
          break;
        case 'message_sent':
          console.log('✅ Message sent successfully');
          break;
        case 'chat_status':
          console.log('📊 Chat status received');
          break;
        case 'debug_info':
          console.log('🔍 Debug info received');
          break;
        case 'pong':
          console.log('🏓 Pong received');
          break;
        case 'error':
          console.log('❌ Error received:', message.message);
          break;
        default:
          console.log('📥 Unknown message type:', message.type);
      }
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
testMessaging().catch(console.error);
