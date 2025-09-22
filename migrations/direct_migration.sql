-- Direct SQL migration to add columns to the chats table
-- Run this in the Supabase SQL editor if the Node.js script doesn't work

-- Add display_name column if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                WHERE table_schema = 'public' 
                AND table_name = 'chats' 
                AND column_name = 'display_name') THEN
    ALTER TABLE public.chats ADD COLUMN display_name text;
    RAISE NOTICE 'Added display_name column';
  ELSE
    RAISE NOTICE 'display_name column already exists';
  END IF;
END
$$;

-- Add other_user_email column if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                WHERE table_schema = 'public' 
                AND table_name = 'chats' 
                AND column_name = 'other_user_email') THEN
    ALTER TABLE public.chats ADD COLUMN other_user_email text;
    RAISE NOTICE 'Added other_user_email column';
  ELSE
    RAISE NOTICE 'other_user_email column already exists';
  END IF;
END
$$;