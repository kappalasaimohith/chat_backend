# Database Migrations

## Migration Options

There are two ways to run the migrations to add the required columns to the `chats` table:

### Option 1: Using the Node.js Script

Run the migration script from the backend directory:

```bash
cd backend
node run_migration.js
```

This script will attempt to add the `display_name` and `other_user_email` columns to the `chats` table using the Supabase API.

### Option 2: Manual SQL Execution (Recommended if Option 1 fails)

If the Node.js script fails, you can run the SQL directly in the Supabase SQL Editor:

1. Log in to your Supabase dashboard
2. Navigate to the SQL Editor
3. Copy and paste the contents of `direct_migration.sql` into the editor
4. Run the SQL

The SQL in `direct_migration.sql` will:
- Check if the `display_name` column exists and add it if it doesn't
- Check if the `other_user_email` column exists and add it if it doesn't

## Troubleshooting

If you encounter the error `Could not find the function public.exec_sql(sql) in the schema cache`, it means the Supabase instance doesn't have the `exec_sql` RPC function available. In this case, use Option 2 (Manual SQL Execution) instead.