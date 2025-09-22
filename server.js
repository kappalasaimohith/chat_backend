
import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import dotenv from "dotenv";
// import fetch from "node-fetch";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import setupWebSocket from "./wsHandler.js";
import { supabase, supabaseAdmin, verifyJWT, createUserClient } from "./supabaseClient.js";
import process from "process";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();

console.log(process.env.FRONTEND_URL);
const allowedOrigins = [
  // 'http://localhost:5173',
  // 'http://localhost:4173',
  process.env.FRONTEND_URL, // Ensure this is set in your .env file
];

// Configure CORS middleware
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json());

// Serve static files from the frontend build directory
app.use(express.static(path.join(__dirname, '../chat_app_front/dist')));

// Middleware to extract and verify JWT from Authorization header
const authenticateJWT = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization header required' });
    }
    
    const token = authHeader.substring(7);
    const { valid, user, error } = await verifyJWT(token);
    
    if (!valid || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    
    req.user = user;
    req.userJwt = token;
    next();
  } catch (err) {
    console.error('JWT verification error:', err);
    return res.status(500).json({ error: 'Authentication failed' });
  }
};

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// List Chats - GET /api/chats
app.get("/api/chats", authenticateJWT, async (req, res) => {
  try {
    const userId = req.user.id;
    const userClient = createUserClient(req.userJwt);

    // 1. Get chats for authenticated user
    const { data, error } = await userClient
      .from("chat_members")
      .select(`
        chat_id,
        chats(
          id,
          name,
          is_group,
          created_at
        )
      `)
      .eq("user_id", userId);

    if (error) {
      console.error("❌ Error fetching chats:", error);
      return res.status(500).json({ error: error.message });
    }

    // 2. Build baseChats
    const baseChats = data.map(item => ({
      id: item.chat_id,
      name: item.chats.name,
      is_group: item.chats.is_group,
      created_at: item.chats.created_at,
      display_name: item.chats.is_group ? item.chats.name : null,
      other_user_email: null,
      user_emails: []
    }));

    // 3. Collect DM chat IDs
    const dmChatIds = baseChats.filter(c => !c.is_group).map(c => c.id);

    let dmMembers = [];
    if (dmChatIds.length > 0) {
      const { data: membersData, error: dmMembersErr } = await userClient
        .from("chat_members")
        .select("chat_id, user_id")
        .in("chat_id", dmChatIds);

      if (!dmMembersErr && Array.isArray(membersData)) {
        dmMembers = membersData;
      }
    }

    // 4. Resolve user_id → email mapping dynamically
    const idToEmail = new Map();

    for (const chat of baseChats) {
      if (!chat.is_group) {
        const members = dmMembers
          .filter(m => m.chat_id === chat.id)
          .map(m => String(m.user_id));

        const otherId = members.find(uid => uid !== String(userId));

        if (otherId) {
          let email = idToEmail.get(otherId);
          console.log("Cached email for user:", email);
          // If not already cached, fetch directly
          if (!email) {
            try {
              const { data, error } = await supabaseAdmin.auth.admin.getUserById(otherId);
              console.log("Fetched email for user:", data?.user?.email);
              if (data?.user) {
                email = data.user.email;
                idToEmail.set(otherId, email);
              } else if (error) {
                console.error("❌ getUserById error:", error);
              }
            } catch (e) {
              console.error("❌ Exception while fetching user:", e);
            }
          }

          chat.other_user_email = email || "Unknown User";
          chat.display_name = chat.other_user_email;
          chat.user_emails = members.map(
            uid => idToEmail.get(uid) || (uid === String(userId) ? req.user.email : "Unknown User")
          );
        }
      }
    }

    // 5. Send response
    res.json(baseChats);
  } catch (err) {
    console.error("❌ Error in /api/chats GET:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});



// Get Message History - GET /api/chats/:chat_id/messages
app.get("/api/chats/:chat_id/messages", authenticateJWT, async (req, res) => {
  try {
    const { chat_id } = req.params;
    const { limit = 100 } = req.query;
    // 1. Get messages from persistent buffer (wsHandler)
    let bufferMessages = [];
    if (Array.isArray(global.messageBuffer)) {
      bufferMessages = global.messageBuffer.filter(m => m.chat_id === chat_id);
    }
    // 2. Get messages from DB
    let dbMessages = [];
    try {
      const { data, error } = await supabaseAdmin
        .from('messages')
        .select('*')
        .eq('chat_id', chat_id)
        .order('inserted_at', { ascending: true })
        .limit(Number(limit));
      if (!error && Array.isArray(data)) {
        dbMessages = data;
      }
    } catch (e) {
      console.warn('Could not fetch messages from DB:', e);
    }
    // Merge and deduplicate by id
    const allMessages = [...dbMessages, ...bufferMessages].reduce((acc, msg) => {
      acc[msg.id] = msg;
      return acc;
    }, {});
    const result = Object.values(allMessages).sort((a, b) => new Date(a.inserted_at) - new Date(b.inserted_at));
    return res.json(result);
  } catch (err) {
    console.error("Error in /api/chats/:chat_id/messages GET:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
// Create Chat - POST /api/chats
app.post("/api/chats", authenticateJWT, async (req, res) => {
  console.log('🚀 POST /api/chats - Chat creation request received');
  console.log('👤 Creator ID:', req.user.id);
  console.log('👤 Creator email:', req.user.email);
  console.log('📦 Request body:', req.body);
  console.log('🔑 Authorization header present:', !!req.headers.authorization);
  
  try {
    const { other_user_id, name, member_ids, is_group } = req.body;
    const creatorId = req.user.id;
    
    console.log('📋 Parsed request data:', { other_user_id, name, member_ids, is_group, creatorId });
    
  if (is_group) {
      console.log('👥 Processing group chat creation...');
      
      // Group chat creation
      if (!member_ids || !Array.isArray(member_ids) || member_ids.length < 1) {
        console.log('❌ Group chat validation failed:', { member_ids, isArray: Array.isArray(member_ids), length: member_ids?.length });
        return res.status(400).json({ error: "At least 1 member_id required for group chats" });
      }
      
      if (!name || typeof name !== 'string' || name.trim() === '') {
        console.log('❌ Group name validation failed:', { name, type: typeof name, trimmed: name?.trim() });
        return res.status(400).json({ error: "Group name is required" });
      }
      
      const finalMemberIds = [...new Set([creatorId, ...member_ids])];
      if (finalMemberIds.length < 2) {
        console.log('❌ Group chat validation failed after including creator:', { finalMemberIds });
        return res.status(400).json({ error: "Group must include at least two distinct members including you" });
      }
      console.log('✅ Group chat validation passed');
      console.log('👥 Final member IDs (including creator):', finalMemberIds);
      
      // Create group chat directly using service role (bypass RLS for writes)
      console.log('🛠️ Creating group chat via service role...');
      const { data: chat, error: createChatError } = await supabaseAdmin
        .from('chats')
        .insert({ name, is_group: true })
        .select()
        .single();
      if (createChatError) {
        console.error('❌ Failed to create group chat:', createChatError);
        return res.status(500).json({ error: 'Failed to create group chat' });
      }
      // Add members to chat_members
      const chatId = chat.id;
      const memberRows = finalMemberIds.map(uid => ({ chat_id: chatId, user_id: uid }));
      const { error: addMembersError } = await supabaseAdmin
        .from('chat_members')
        .insert(memberRows);
      if (addMembersError) {
        console.error('❌ Failed to add members to group chat:', addMembersError);
        return res.status(500).json({ error: 'Failed to add members to group chat' });
      }
      res.status(201).json({ chat_id: chatId });
    } else {
      // Direct message chat creation
      if (!other_user_id) {
        return res.status(400).json({ error: "other_user_id is required for direct messages" });
      }
      // Check if a DM already exists between these two users (not a group chat)
      const { data: sharedChats, error: sharedChatsErr } = await supabase
        .from('chat_members')
        .select('chat_id, user_id')
        .or(`user_id.eq.${creatorId},user_id.eq.${other_user_id}`);
      if (sharedChatsErr) {
        return res.status(500).json({ error: 'Failed to check for existing DM' });
      }
      const chatIds = sharedChats.map(c => c.chat_id);
      let existingDMId = null;
      if (chatIds.length > 0) {
        const { data: chats, error: chatsErr } = await supabase
          .from('chats')
          .select('id, is_group')
          .in('id', chatIds);
        if (chatsErr) {
          return res.status(500).json({ error: 'Failed to check chat type' });
        }
        // Find a chat that is not a group and has both users as members
        for (const chat of chats) {
          if (!chat.is_group) {
            const members = sharedChats.filter(m => m.chat_id === chat.id).map(m => m.user_id);
            if (members.includes(creatorId) && members.includes(other_user_id)) {
              existingDMId = chat.id;
              break;
            }
          }
        }
      }
      if (existingDMId) {
        return res.status(200).json({ chat_id: existingDMId, existing: true });
      }
      // Create the DM chat
      const { data: chat, error: chatError } = await supabaseAdmin
        .from('chats')
        .insert({ is_group: false })
        .select()
        .single();
      if (chatError) {
        return res.status(500).json({ error: 'Failed to create chat' });
      }
      // Add both users to chat_members
      // Add both users to chat_members (idempotent)
      const { error: addMembersError } = await supabaseAdmin
        .from('chat_members')
        .insert([
          { chat_id: chat.id, user_id: creatorId },
          { chat_id: chat.id, user_id: other_user_id }
        ], { upsert: true, onConflict: ['chat_id', 'user_id'] });
      if (addMembersError) {
        return res.status(500).json({ error: 'Failed to add members to chat' });
      }
      res.status(201).json({ chat_id: chat.id });
    }
  } catch (err) {
    console.error('Error in /api/chats POST:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});


// Send Message - POST /api/chats/:chat_id/messages
app.post("/api/chats/:chat_id/messages", authenticateJWT, async (req, res) => {
  try {
    const { chat_id } = req.params;
    const { content } = req.body;
    const userId = req.user.id;
    
    if (!content || typeof content !== 'string' || content.trim() === '') {
      return res.status(400).json({ error: "Message content is required" });
    }
    
    // Check if user is a member of this chat
    const userClient = createUserClient(req.userJwt);
    const { data: membership, error: membershipError } = await userClient
      .from("chat_members")
      .select("*")
      .eq("chat_id", chat_id)
      .eq("user_id", userId)
      .single();
    
    if (membershipError || !membership) {
      return res.status(403).json({ error: "You are not a member of this chat" });
    }
    
    // Create message object
    const message = {
      chat_id,
      sender_id: userId,
      content,
      inserted_at: new Date().toISOString()
    };
    
    // Add to message buffer in wsHandler and broadcast to all connected clients
    const messageId = global.enqueueMessage(message);
    
    return res.json({ message_id: messageId, success: true });
  } catch (err) {
    console.error("Error in /api/chats/:chat_id/messages POST:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Search Users - GET /api/users/search?q=search_term
app.get("/api/users/search", authenticateJWT, async (req, res) => {
  console.log('🔍 GET /api/users/search - User search request received');
  console.log('👤 Current user ID:', req.user.id);
  console.log('👤 Current user email:', req.user.email);
  console.log('🔍 Search query:', req.query.q);
  
  try {
    const { q } = req.query;
    const currentUserId = req.user.id;
    
    if (!q || typeof q !== 'string' || q.trim() === '') {
      console.log('❌ Search query validation failed:', { q, type: typeof q, trimmed: q?.trim() });
      return res.status(400).json({ error: "Search query is required" });
    }
    
    console.log('✅ Search query validation passed');
    console.log('🔍 Searching for users (Auth Admin API) with query:', q.trim());
    console.log('🚫 Excluding current user ID:', currentUserId);

    const query = q.trim();
    const resultsMap = new Map();

    // Helper to maybe add user to results, excluding current user
    const addUser = (user) => {
      if (!user) return;
      if (user.id === currentUserId) return;
      resultsMap.set(user.id, {
        id: user.id,
        email: user.email,
        created_at: user.created_at
      });
    };

    // If the query is an exact email, try a direct lookup first
    if (query.includes('@')) {
      try {
        const { data: byEmail, error: byEmailErr } = await supabaseAdmin.auth.admin.getUserByEmail(query);
        if (byEmailErr) {
          console.warn('⚠️ getUserByEmail error (continuing with listUsers):', byEmailErr);
        } else if (byEmail?.user) {
          addUser(byEmail.user);
        }
      } catch (byEmailEx) {
        console.warn('⚠️ getUserByEmail threw (continuing with listUsers):', byEmailEx);
      }
    }

    // Fallback/partial search: list users and filter client-side
    const { data: listData, error: listErr } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 100 });
    if (listErr) {
      console.error('❌ listUsers error:', listErr);
      // Degrade gracefully: continue with whatever results we have (possibly empty)
    }

    const lowered = query.toLowerCase();
    for (const u of listData?.users || []) {
      if (typeof u.email === 'string' && u.email.toLowerCase().includes(lowered)) {
        addUser(u);
      }
    }

    // Limit to 10 results for UI
    const userList = Array.from(resultsMap.values()).slice(0, 10);
    
    console.log('✅ Transformed user list:', userList);
    console.log('📊 Total users found:', userList.length);
    
    res.json(userList);
  } catch (err) {
    console.error("❌ Error in /api/users/search GET:", err);
    console.error("❌ Error stack:", err.stack);
    res.status(500).json({ error: "Internal server error" });
  }
});


// Debug endpoint: Get all users (with email) in a chat
app.get("/api/chats/:chat_id/users", authenticateJWT, async (req, res) => {
  try {
    const { chat_id } = req.params;
    // Get all user_ids in the chat
    const { data: members, error: membersError } = await supabaseAdmin
      .from("chat_members")
      .select("user_id")
      .eq("chat_id", chat_id);
    if (membersError) {
      return res.status(500).json({ error: membersError.message });
    }
    const userIds = members.map(m => m.user_id);
    // Fetch user info (email) for all user_ids
    const users = [];
    for (const id of userIds) {
      try {
        const { data, error } = await supabaseAdmin.auth.admin.getUserById(id);
        if (!error && data?.user) {
          users.push({ user_id: data.user.id, email: data.user.email });
        } else {
          users.push({ user_id: id, email: 'Unknown User' });
        }
      } catch {
        users.push({ user_id: id, email: 'Unknown User' });
      }
    }
    res.json(users);
  } catch (err) {
    console.error("Error in /api/chats/:chat_id/users GET:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get User Profile - GET /api/users/:user_id
app.get("/api/users/:user_id", authenticateJWT, async (req, res) => {
  try {
    const { user_id } = req.params;
    const currentUserId = req.user.id;
    
    // Users can only view their own profile or basic info of other users
    if (user_id === currentUserId) {
      // Get full profile for current user via Auth Admin API
      const { data, error } = await supabaseAdmin.auth.admin.getUserById(user_id);
      if (error) {
        console.error("Error fetching user profile:", error);
        return res.status(500).json({ error: "Failed to fetch user profile" });
      }
      const user = data?.user ? {
        id: data.user.id,
        email: data.user.email,
        created_at: data.user.created_at,
        updated_at: data.user.updated_at
      } : null;
      
      if (error) {
        console.error("Error fetching user profile:", error);
        return res.status(500).json({ error: "Failed to fetch user profile" });
      }
      
      res.json(user);
    } else {
      // Get basic info for other users via Auth Admin API
      const { data, error } = await supabaseAdmin.auth.admin.getUserById(user_id);
      if (error || !data?.user) {
        console.error("Error fetching user info:", error);
        return res.status(404).json({ error: "User not found" });
      }
      const user = {
        id: data.user.id,
        email: data.user.email,
        created_at: data.user.created_at
      };
      
      if (error) {
        console.error("Error fetching user info:", error);
        return res.status(404).json({ error: "User not found" });
      }
      
      res.json(user);
    }
  } catch (err) {
    console.error("Error in /api/users/:user_id GET:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Delete a chat and all its members/messages - DELETE /api/chats/:chat_id
app.delete("/api/chats/:chat_id", authenticateJWT, async (req, res) => {
  try {
    const { chat_id } = req.params;
    // Only allow deleting if user is a member
    const { data: members, error: memberErr } = await supabaseAdmin
      .from('chat_members')
      .select('user_id')
      .eq('chat_id', chat_id);
    if (memberErr) return res.status(500).json({ error: memberErr.message });
    if (!members.some(m => m.user_id === req.user.id)) {
      return res.status(403).json({ error: 'Not a member of this chat' });
    }
    // Delete chat (cascades to chat_members and messages)
    const { error: delErr } = await supabaseAdmin
      .from('chats')
      .delete()
      .eq('id', chat_id);
    if (delErr) return res.status(500).json({ error: delErr.message });
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting chat:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add User to Group - POST /api/chats/:chat_id/members
app.post("/api/chats/:chat_id/members", authenticateJWT, async (req, res) => {
  try {
    const { chat_id } = req.params;
    const { user_id } = req.body;
    const currentUserId = req.user.id;
    
    if (!user_id) {
      return res.status(400).json({ error: "user_id is required" });
    }
    
    // Verify the chat exists and is a group chat
    const userClient = createUserClient(req.userJwt);
    const { data: chat, error: chatError } = await userClient
      .from("chats")
      .select("id, is_group, name")
      .eq("id", chat_id)
      .single();
    
    if (chatError || !chat) {
      return res.status(404).json({ error: "Chat not found" });
    }
    
    if (!chat.is_group) {
      return res.status(400).json({ error: "Cannot add members to direct chats" });
    }
    
    // Verify current user is a member of this group
    const { data: membership, error: membershipError } = await userClient
      .from("chat_members")
      .select("chat_id")
      .eq("chat_id", chat_id)
      .eq("user_id", currentUserId)
      .single();
    
    if (membershipError || !membership) {
      return res.status(403).json({ error: "You are not a member of this group" });
    }
    
    // Check if user is already a member
    const { data: existingMember, error: existingMemberError } = await userClient
      .from("chat_members")
      .select("chat_id")
      .eq("chat_id", chat_id)
      .eq("user_id", user_id)
      .single();
    
    if (existingMember) {
      return res.status(400).json({ error: "User is already a member of this group" });
    }
    
    // Add user to the group
    const { error: addMemberError } = await supabaseAdmin
      .from("chat_members")
      .insert({
        chat_id,
        user_id
      });
    
    if (addMemberError) {
      console.error("Error adding user to group:", addMemberError);
      return res.status(500).json({ error: "Failed to add user to group" });
    }
    
    res.json({ success: true, message: "User added to group successfully" });
  } catch (err) {
    console.error("Error in /api/chats/:chat_id/members POST:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Remove User from Group - DELETE /api/chats/:chat_id/members/:user_id
app.delete("/api/chats/:chat_id/members/:user_id", authenticateJWT, async (req, res) => {
  try {
    const { chat_id, user_id } = req.params;
    const currentUserId = req.user.id;
    
    // Verify the chat exists and is a group chat
    const userClient = createUserClient(req.userJwt);
    const { data: chat, error: chatError } = await userClient
      .from("chats")
      .select("id, is_group, name")
      .eq("id", chat_id)
      .single();
    
    if (chatError || !chat) {
      return res.status(404).json({ error: "Chat not found" });
    }
    
    if (!chat.is_group) {
      return res.status(400).json({ error: "Cannot remove members from direct chats" });
    }
    
    // Verify current user is a member of this group
    const { data: membership, error: membershipError } = await userClient
      .from("chat_members")
      .select("chat_id")
      .eq("chat_id", chat_id)
      .eq("user_id", currentUserId)
      .single();
    
    if (membershipError || !membership) {
      return res.status(403).json({ error: "You are not a member of this group" });
    }
    
    // Check if user is actually a member
    const { data: existingMember, error: existingMemberError } = await userClient
      .from("chat_members")
      .select("chat_id")
      .eq("chat_id", chat_id)
      .eq("user_id", user_id)
      .single();
    
    if (!existingMember) {
      return res.status(400).json({ error: "User is not a member of this group" });
    }
    
    // Remove user from the group
    const { error: removeMemberError } = await supabaseAdmin
      .from("chat_members")
      .delete()
      .eq("chat_id", chat_id)
      .eq("user_id", user_id);
    
    if (removeMemberError) {
      console.error("Error removing user from group:", removeMemberError);
      return res.status(500).json({ error: "Failed to remove user from group" });
    }
    
    res.json({ success: true, message: "User removed from group successfully" });
  } catch (err) {
    console.error("Error in /api/chats/:chat_id/members/:user_id DELETE:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get Group Members - GET /api/chats/:chat_id/members
app.get("/api/chats/:chat_id/members", authenticateJWT, async (req, res) => {
  try {
    const { chat_id } = req.params;
    const currentUserId = req.user.id;
    console.log(`[GroupMembersAPI] Looking up chat_id:`, chat_id);

    // Use supabaseAdmin to bypass RLS and ensure chat is found
    const { data: chat, error: chatError } = await supabaseAdmin
      .from("chats")
      .select("id, is_group, name, created_by")
      .eq("id", chat_id)
      .single();

    console.log(`[GroupMembersAPI] chat lookup result:`, chat, chatError);

    if (chatError || !chat) {
      console.warn(`[GroupMembersAPI] Chat not found for id:`, chat_id, chatError);
      return res.status(404).json({ error: "Chat not found" });
    }

    if (!chat.is_group) {
      console.warn(`[GroupMembersAPI] Chat is not a group:`, chat_id);
      return res.status(400).json({ error: "This endpoint is only for group chats" });
    }

    // Verify current user is a member of this group
    const userClient = createUserClient(req.userJwt);
    const { data: membership, error: membershipError } = await userClient
      .from("chat_members")
      .select("chat_id")
      .eq("chat_id", chat_id)
      .eq("user_id", currentUserId)
      .single();

    console.log(`[GroupMembersAPI] membership lookup:`, membership, membershipError);

    if (membershipError || !membership) {
      console.warn(`[GroupMembersAPI] User is not a member:`, currentUserId, chat_id);
      return res.status(403).json({ error: "You are not a member of this group" });
    }

    // Get all members of this group
    const { data: members, error: membersError } = await supabaseAdmin
      .from("chat_members")
      .select(`user_id`)
      .eq("chat_id", chat_id);

    console.log(`[GroupMembersAPI] members:`, members, membersError);

    if (membersError) {
      console.error("Error fetching group members:", membersError);
      return res.status(500).json({ error: "Failed to fetch group members" });
    }

    // Fetch user info (email) for all member user_ids via Auth Admin API
    const userIds = members.map(m => m.user_id);
    const usersById = {};
    if (userIds.length > 0) {
      const fetches = userIds.map(async (id) => {
        const { data, error } = await supabaseAdmin.auth.admin.getUserById(id);
        if (error) {
          console.warn('⚠️ Failed to fetch user by id for group member:', id, error);
          return;
        }
        if (data?.user) {
          usersById[id] = {
            id: data.user.id,
            email: data.user.email,
            created_at: data.user.created_at
          };
        }
      });
      await Promise.all(fetches);
    }

    // Transform the data to include user email
    const memberList = members.map(member => ({
      user_id: member.user_id,
      email: usersById[member.user_id]?.email || 'Unknown User'
    }));

    // Return admin_id for frontend admin controls
    res.json({ members: memberList, admin_id: chat.created_by });
  } catch (err) {
    console.error("Error in /api/chats/:chat_id/members GET:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// WebSocket endpoint
app.get("/ws", (req, res) => {
  res.status(400).json({ error: "WebSocket connections should use the /ws endpoint directly" });
});

// Catch-all route to serve the frontend for client-side routing
app.get('*', (req, res) => {
  // Skip API routes
  if (req.path.startsWith('/api/') || req.path === '/ws') {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});

// WebSocket setup
const server = http.createServer(app);
const wss = new WebSocketServer({ 
  server,
  path: "/ws"
});

setupWebSocket(wss);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`🔌 WebSocket endpoint: ws://localhost:${PORT}/ws`);
});
