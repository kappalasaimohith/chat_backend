-- Migration to add display_name and other_user_email columns to chats table
ALTER TABLE public.chats ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE public.chats ADD COLUMN IF NOT EXISTS other_user_email text;

-- Update existing direct chats with email information
DO $$
DECLARE
  chat_record RECORD;
  other_user_id UUID;
  other_user_email TEXT;
BEGIN
  FOR chat_record IN SELECT c.id FROM public.chats c WHERE c.is_group = false LOOP
    -- Find the other user in this chat
    SELECT cm.user_id INTO other_user_id 
    FROM public.chat_members cm 
    WHERE cm.chat_id = chat_record.id 
    AND cm.user_id != auth.uid() 
    LIMIT 1;
    
    -- Get the email for this user
    IF other_user_id IS NOT NULL THEN
      SELECT email INTO other_user_email FROM auth.users WHERE id = other_user_id;
      
      -- Update the chat with this information
      IF other_user_email IS NOT NULL THEN
        UPDATE public.chats 
        SET display_name = other_user_email, other_user_email = other_user_email 
        WHERE id = chat_record.id;
      END IF;
    END IF;
  END LOOP;
END;
$$;