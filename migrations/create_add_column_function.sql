-- Function to add a column to the chats table
CREATE OR REPLACE FUNCTION public.add_column_to_chats(column_name text, column_type text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  column_exists boolean;
  sql_statement text;
BEGIN
  -- Check if column exists
  SELECT EXISTS (
    SELECT 1 
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'chats' 
    AND column_name = add_column_to_chats.column_name
  ) INTO column_exists;
  
  -- Add column if it doesn't exist
  IF NOT column_exists THEN
    sql_statement := format('ALTER TABLE public.chats ADD COLUMN %I %s', 
                           add_column_to_chats.column_name, 
                           add_column_to_chats.column_type);
    EXECUTE sql_statement;
  END IF;
END;
$$;