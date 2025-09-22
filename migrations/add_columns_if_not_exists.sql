-- Add columns if they don't exist
DO $$
BEGIN
    -- Check if display_name column exists
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                  WHERE table_schema = 'public' 
                  AND table_name = 'chats' 
                  AND column_name = 'display_name') THEN
        ALTER TABLE public.chats ADD COLUMN display_name text;
    END IF;
    
    -- Check if other_user_email column exists
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                  WHERE table_schema = 'public' 
                  AND table_name = 'chats' 
                  AND column_name = 'other_user_email') THEN
        ALTER TABLE public.chats ADD COLUMN other_user_email text;
    END IF;
    
    -- Log that the migration has been executed
    RAISE NOTICE 'Migration completed: Added display_name and other_user_email columns if they did not exist';
END;
$$;