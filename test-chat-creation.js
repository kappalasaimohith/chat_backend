import fetch from 'node-fetch';

// Test chat creation functionality
async function testChatCreation() {
  console.log('🧪 Testing Chat Creation API...');
  
  const baseUrl = 'http://localhost:5000';
  
  // Test data
  const testUser = {
    email: 'test@example.com',
    password: 'testpassword123'
  };
  
  try {
    // Step 1: Test user search
    console.log('\n🔍 Step 1: Testing user search...');
    const searchResponse = await fetch(`${baseUrl}/api/users/search?q=test`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test_token_123' // This will fail auth, but we'll see the endpoint
      }
    });
    
    console.log('📡 User search response status:', searchResponse.status);
    if (searchResponse.ok) {
      const users = await searchResponse.json();
      console.log('✅ Users found:', users);
    } else {
      const errorText = await searchResponse.text();
      console.log('❌ User search failed:', errorText);
    }
    
    // Step 2: Test direct chat creation
    console.log('\n💬 Step 2: Testing direct chat creation...');
    const directChatData = {
      is_group: false,
      other_user_id: 'test-user-123'
    };
    
    const directChatResponse = await fetch(`${baseUrl}/api/chats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test_token_123'
      },
      body: JSON.stringify(directChatData)
    });
    
    console.log('📡 Direct chat response status:', directChatResponse.status);
    if (directChatResponse.ok) {
      const result = await directChatResponse.json();
      console.log('✅ Direct chat created:', result);
    } else {
      const errorText = await directChatResponse.text();
      console.log('❌ Direct chat creation failed:', errorText);
    }
    
    // Step 3: Test group chat creation
    console.log('\n👥 Step 3: Testing group chat creation...');
    const groupChatData = {
      is_group: true,
      name: 'Test Group Chat',
      member_ids: ['member-1', 'member-2']
    };
    
    const groupChatResponse = await fetch(`${baseUrl}/api/chats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test_token_123'
      },
      body: JSON.stringify(groupChatData)
    });
    
    console.log('📡 Group chat response status:', groupChatResponse.status);
    if (groupChatResponse.ok) {
      const result = await groupChatResponse.json();
      console.log('✅ Group chat created:', result);
    } else {
      const errorText = await groupChatResponse.text();
      console.log('❌ Group chat creation failed:', errorText);
    }
    
    // Step 4: Test with invalid data
    console.log('\n❌ Step 4: Testing invalid data validation...');
    
    // Test empty group name
    const invalidGroupData = {
      is_group: true,
      name: '',
      member_ids: ['member-1']
    };
    
    const invalidGroupResponse = await fetch(`${baseUrl}/api/chats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test_token_123'
      },
      body: JSON.stringify(invalidGroupData)
    });
    
    console.log('📡 Invalid group response status:', invalidGroupResponse.status);
    if (!invalidGroupResponse.ok) {
      const errorText = await invalidGroupResponse.text();
      console.log('✅ Validation error (expected):', errorText);
    }
    
    // Test missing member IDs
    const invalidMembersData = {
      is_group: true,
      name: 'Test Group',
      member_ids: []
    };
    
    const invalidMembersResponse = await fetch(`${baseUrl}/api/chats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test_token_123'
      },
      body: JSON.stringify(invalidMembersData)
    });
    
    console.log('📡 Invalid members response status:', invalidMembersResponse.status);
    if (!invalidMembersResponse.ok) {
      const errorText = await invalidMembersResponse.text();
      console.log('✅ Validation error (expected):', errorText);
    }
    
    console.log('\n✅ Chat creation API testing completed!');
    
  } catch (error) {
    console.error('❌ Test failed with error:', error);
  }
}

// Run the test
testChatCreation().catch(console.error);
