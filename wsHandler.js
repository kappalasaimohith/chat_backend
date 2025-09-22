import { verifyJWT, supabaseAdmin } from "./supabaseClient.js";
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

// Room management: chat_id -> Set of WebSocket connections
const chatRooms = new Map();
// User socket mapping: user_id -> Set of WebSocket connections
const userSockets = new Map();
// Per-user message queue for offline delivery: user_id -> [messages]
const offlineMessageQueue = new Map();
// Message buffer for batching
const messageBuffer = [];
const BATCH_INTERVAL = 1000; // 1 second as per requirements
const WRITE_BATCH_URL = process.env.WRITE_BATCH_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BATCH_SECRET_HEADER = process.env.BATCH_SECRET_HEADER;
let batchTimer = null;
let isFlushingBatch = false;

// Create a directory for message persistence if it doesn't exist
const DATA_DIR = path.join(process.cwd(), 'data');
const MESSAGE_QUEUE_FILE = path.join(DATA_DIR, 'message_queue.json');

try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Load any persisted messages from disk
  if (fs.existsSync(MESSAGE_QUEUE_FILE)) {
    const persistedMessages = JSON.parse(fs.readFileSync(MESSAGE_QUEUE_FILE, 'utf8'));
    if (Array.isArray(persistedMessages)) {
      messageBuffer.push(...persistedMessages);
      console.log(`Loaded ${persistedMessages.length} persisted messages from disk`);
    }
  }
} catch (err) {
  console.error('Error initializing message persistence:', err);
}

// Function to enqueue a message and broadcast it
function enqueueMessage(message) {
  // Generate a UUID for the message if not provided
  const messageId = message.id || uuidv4();
  const messageWithId = { ...message, id: messageId };

  console.log(`Enqueuing message: ${messageId} for chat ${message.chat_id} from user ${message.sender_id}`);

  // Add to buffer
  messageBuffer.push(messageWithId);

  // Persist to disk
  try {
    fs.writeFileSync(MESSAGE_QUEUE_FILE, JSON.stringify(messageBuffer), 'utf8');
  } catch (err) {
    console.error('Error persisting message queue:', err);
  }

  // Broadcast to all clients in the chat room
  broadcastMessage(messageWithId);

  // Start the batch timer if not already running
  if (batchTimer === null) {
    startBatchTimer();
  }

  return { messageId };
}

// Function to broadcast a message to all clients in a chat room and queue for offline users
async function broadcastMessage(message) {
  const { chat_id, sender_id } = message;
  // Fetch sender email for display
  let sender_email = sender_id;
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(sender_id);
    if (!error && data?.user?.email) {
      sender_email = data.user.email;
    }
  } catch (e) {
    // ignore
  }
  const messageEvent = JSON.stringify({
    type: 'new_message',
    id: message.id,
    chat_id: message.chat_id,
    sender_id: message.sender_id,
    sender_email,
    content: message.content,
    inserted_at: message.inserted_at
  });

  // Get all chat members (excluding sender)
  let chatMemberIds = [];
  try {
    const { data: members, error } = await supabaseAdmin
      .from('chat_members')
      .select('user_id')
      .eq('chat_id', chat_id);
    if (!error && Array.isArray(members)) {
      chatMemberIds = members.map(m => m.user_id).filter(id => id !== sender_id);
    }
  } catch (e) {
    console.error('Error fetching chat members for offline queue:', e);
  }

  // Track which users have received this message for logging purposes
  const notifiedUsers = new Set();
  let sentCount = 0;

  // Send to all connected members (except sender)
  for (const userId of chatMemberIds) {
    let delivered = false;
    if (userSockets.has(userId)) {
      userSockets.get(userId).forEach(client => {
        try {
          if (client.readyState === 1) {
            client.send(messageEvent);
            notifiedUsers.add(userId);
            sentCount++;
            delivered = true;
          }
        } catch (error) {
          // Remove broken connections
          if (client.readyState !== 1) {
            userSockets.get(userId).delete(client);
          }
        }
      });
    }
    // If not delivered, queue for offline delivery
    if (!delivered) {
      if (!offlineMessageQueue.has(userId)) offlineMessageQueue.set(userId, []);
      offlineMessageQueue.get(userId).push(message);
      // Optionally, persist offline queue to disk here
    }
  }

  // Always send to the sender's socket, even if not in the room
  if (userSockets.has(sender_id)) {
    userSockets.get(sender_id).forEach(client => {
      try {
        if (client.readyState === 1) {
          client.send(messageEvent);
          notifiedUsers.add(sender_id);
          sentCount++;
        }
      } catch (error) {
        // Ignore errors here
      }
    });
  }

  console.log(`Message broadcasted to ${sentCount} connections (${notifiedUsers.size} unique users) in chat ${chat_id}`);
}

// Function to start the batch timer
function startBatchTimer() {
  if (batchTimer !== null) return;

  console.log('Starting batch timer');
  batchTimer = setInterval(flushMessageBatch, BATCH_INTERVAL);
}

// Function to flush the message batch to Supabase
async function flushMessageBatch() {
  if (isFlushingBatch || messageBuffer.length === 0) return;

  isFlushingBatch = true;
  console.log(`Flushing ${messageBuffer.length} messages to Supabase`);

  try {
    // Take up to 500 messages from the buffer
    const batchSize = Math.min(messageBuffer.length, 500);
    const batch = messageBuffer.slice(0, batchSize);

    // Verify referenced chats exist to avoid FK violations
    const uniqueChatIds = Array.from(new Set(batch.map(m => m.chat_id).filter(Boolean)));
    let existingChatIds = new Set();
    if (uniqueChatIds.length > 0) {
      const { data: chatsData, error: chatsError } = await supabaseAdmin
        .from('chats')
        .select('id')
        .in('id', uniqueChatIds);
      if (chatsError) {
        console.error('Error verifying chats for batch:', chatsError);
      } else {
        existingChatIds = new Set((chatsData || []).map(c => c.id));
      }
    }

    const validBatch = batch.filter(m => existingChatIds.has(m.chat_id));
    const invalidBatch = batch.filter(m => !existingChatIds.has(m.chat_id));

    if (invalidBatch.length > 0) {
      console.warn(`Dropping ${invalidBatch.length} messages for non-existent chats`);
    }

    // Write only valid messages
    if (validBatch.length > 0) {
      let batchSuccess = false;
      if (WRITE_BATCH_URL && SERVICE_ROLE_KEY && BATCH_SECRET_HEADER) {
        try {
          const resp = await fetch(WRITE_BATCH_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
              'x-secret': BATCH_SECRET_HEADER
            },
            body: JSON.stringify({ messages: validBatch })
          });
          if (resp.ok) {
            batchSuccess = true;
            console.log('Batch flushed to Edge Function successfully');
          } else {
            const txt = await resp.text();
            console.error('Edge Function batch flush failed:', txt);
          }
        } catch (e) {
          console.error('Error calling Edge Function for batch flush:', e);
        }
      }
      // Fallback: direct DB insert (for local/dev)
      if (!batchSuccess) {
        const { error } = await supabaseAdmin
          .from('messages')
          .insert(validBatch);
        if (error) {
          console.error('Error flushing valid message batch to messages table:', error);
          // Do not remove; will retry
          return;
        }
      }
    }

    // Remove processed items (both valid and invalid) from the buffer by id
    const removeIds = new Set([...validBatch, ...invalidBatch].map(m => m.id));
    const beforeLength = messageBuffer.length;
    for (let i = messageBuffer.length - 1; i >= 0; i--) {
      if (removeIds.has(messageBuffer[i].id)) {
        messageBuffer.splice(i, 1);
      }
    }

    // Update the persisted file
    try {
      fs.writeFileSync(MESSAGE_QUEUE_FILE, JSON.stringify(messageBuffer), 'utf8');
    } catch (err) {
      console.error('Error updating persisted message queue:', err);
    }

    console.log(`Successfully flushed ${validBatch.length} messages, dropped ${invalidBatch.length}, remaining ${messageBuffer.length}`);
  } catch (err) {
    console.error('Exception during message batch flush:', err);
  } finally {
    isFlushingBatch = false;
  }
}

// Function to check if a user is in a specific chat room
function isUserInChat(userId, chatId) {
  const room = chatRooms.get(chatId);
  if (!room) return false;
  
  for (const client of room) {
    if (client.userId === userId) {
      return true;
    }
  }
  return false;
}

// Make the enqueueMessage function available globally
global.enqueueMessage = enqueueMessage;

export default function setupWebSocket(wss) {
  // Set up heartbeat interval
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        console.log(`Terminating inactive connection for user ${ws.userEmail || ws.userId || 'unknown'}`);
        return ws.terminate();
      }
      
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000); // 30 seconds

  wss.on("connection", async (ws, req) => {
    console.log("New WebSocket connection attempt from:", req.headers.origin || 'unknown');

    try {
      // Extract JWT token from query string
      const url = new URL(req.url, `http://${req.headers.host}`);
      const token = url.searchParams.get('token');

      if (!token) {
        console.log("No token provided, closing connection");
        ws.close(1008, "No authentication token");
        return;
      }

      console.log("Token received, verifying JWT...");

      // Verify JWT
      const { valid, user, error } = await verifyJWT(token);
      if (!valid || !user) {
        console.log("Invalid JWT, closing connection:", error);
        ws.close(1008, "Invalid authentication token");
        return;
      }

      console.log(`User ${user.id} (${user.email}) connected via WebSocket successfully`);

      // Store user's socket(s)
      if (!userSockets.has(user.id)) userSockets.set(user.id, new Set());
      userSockets.get(user.id).add(ws);
      ws.userId = user.id;
      ws.userEmail = user.email;

      // Deliver any queued offline messages for this user
      if (offlineMessageQueue.has(user.id)) {
        const queued = offlineMessageQueue.get(user.id);
        for (const msg of queued) {
          try {
            ws.send(JSON.stringify({
              type: 'new_message',
              id: msg.id,
              chat_id: msg.chat_id,
              sender_id: msg.sender_id,
              content: msg.content,
              inserted_at: msg.inserted_at
            }));
          } catch (e) {
            console.error('Error delivering queued message to user', user.id, e);
          }
        }
        offlineMessageQueue.delete(user.id);
      }
      
      // Set up ping/pong to keep connection alive
      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
      });

    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw);
        console.log(`Received message from ${ws.userEmail}:`, msg);

        if (msg.type === 'join') {
          // Join chat room
          const { chat_id } = msg;
          if (!chat_id) {
            console.error('No chat_id provided for join message');
            ws.send(JSON.stringify({
              type: 'error',
              message: 'chat_id is required for join message'
            }));
            return;
          }
          
          if (!chatRooms.has(chat_id)) {
            chatRooms.set(chat_id, new Set());
          }
          chatRooms.get(chat_id).add(ws);
          console.log(`User ${ws.userEmail} (${ws.userId}) joined chat ${chat_id}`);
          
          // Send confirmation
          ws.send(JSON.stringify({
            type: 'joined_chat',
            chat_id: chat_id,
            success: true
          }));
        } else if (msg.type === 'new_message') {
          // Handle new message
          const { chat_id, content } = msg;

          if (!chat_id || !content) {
            console.error('Invalid message format:', msg);
            ws.send(JSON.stringify({
              type: 'error',
              message: 'chat_id and content are required for new_message'
            }));
            return;
          }

          // Validate content length
          if (content.trim().length === 0) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Message content cannot be empty'
            }));
            return;
          }

          // Ensure sender is in the chat room so they always get the broadcast
          if (!chatRooms.has(chat_id)) {
            chatRooms.set(chat_id, new Set());
          }
          chatRooms.get(chat_id).add(ws);

          // Create message object with a unique ID
          const messageId = uuidv4();
          const message = {
            id: messageId,
            chat_id,
            sender_id: ws.userId,
            content: content.trim(),
            inserted_at: new Date().toISOString()
          };

          console.log(`Created message object: ${JSON.stringify(message)}`);
          
          // Verify all required fields are present
          if (!message.id || !message.chat_id || !message.content || !message.sender_id) {
            console.error('Message is missing required fields:', message);
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Failed to create message with required fields'
            }));
            return;
          }

          // Enqueue and broadcast the message
          const result = enqueueMessage(message);
          console.log(`Message enqueued with ID: ${result.messageId}`);
          
          // Send confirmation to sender
          ws.send(JSON.stringify({
            type: 'message_sent',
            message_id: result.messageId,
            success: true
          }));
        } else if (msg.type === 'ping') {
          // Handle ping messages for connection health check
          ws.send(JSON.stringify({
            type: 'pong',
            timestamp: Date.now()
          }));
        } else if (msg.type === 'get_chat_status') {
          // Handle chat status requests
          const { chat_id } = msg;
          if (chat_id) {
            const room = chatRooms.get(chat_id);
            const isInRoom = room && room.has(ws);
            ws.send(JSON.stringify({
              type: 'chat_status',
              chat_id: chat_id,
              in_room: isInRoom,
              room_members: room ? room.size : 0
            }));
          }
        } else if (msg.type === 'debug_info') {
          // Handle debug info requests (for troubleshooting)
          const debugInfo = {
            user_id: ws.userId,
            user_email: ws.userEmail,
            active_chats: Array.from(chatRooms.keys()),
            user_chats: [],
            total_users: userSockets.size,
            total_rooms: chatRooms.size
          };
          
          // Get chats where this user is present
          for (const [chatId, room] of chatRooms.entries()) {
            if (room.has(ws)) {
              debugInfo.user_chats.push({
                chat_id: chatId,
                members: room.size
              });
            }
          }
          
          ws.send(JSON.stringify({
            type: 'debug_info',
            data: debugInfo
          }));
        } else {
          console.log(`Unknown message type: ${msg.type}`);
          ws.send(JSON.stringify({
            type: 'error',
            message: `Unknown message type: ${msg.type}`
          }));
        }
      } catch (err) {
        console.error("Error processing WebSocket message:", err);
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Failed to process message'
        }));
      }
    });

    // Handle WebSocket close
    ws.on('close', () => {
      console.log(`WebSocket closed for user ${ws.userId}`);

      // Remove from userSockets map
      if (ws.userId && userSockets.has(ws.userId)) {
        const sockets = userSockets.get(ws.userId);
        sockets.delete(ws);
        if (sockets.size === 0) {
          userSockets.delete(ws.userId);
        }
      }

      // Remove from all chat rooms
      for (const [chatId, room] of chatRooms.entries()) {
        if (room.has(ws)) {
          room.delete(ws);
          console.log(`Removed user ${ws.userId} from chat ${chatId}`);

          // Clean up empty rooms
          if (room.size === 0) {
            chatRooms.delete(chatId);
            console.log(`Removed empty chat room ${chatId}`);
          }
        }
      }
    });
    
    } catch (error) {
      console.error("Error during WebSocket connection setup:", error);
      if (ws.readyState === ws.CONNECTING || ws.readyState === ws.OPEN) {
        ws.close(1011, "Internal server error");
      }
    }
  });

  // Start the batch timer
  startBatchTimer();

  // Cleanup function
  const cleanup = () => {
    clearInterval(heartbeatInterval);
    clearInterval(batchTimer);
  };

  // Handle process termination
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  return {
    enqueueMessage,
    flushMessageBatch,
    broadcastMessage,
    isUserInChat,
    cleanup
  };
}
