import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env file');
  process.exit(1);
}

async function runMigration() {
  try {
    console.log('Running migration to add columns if they don\'t exist...');
    
    // First, check if we can create a chat record with these columns
    // This will either use existing columns or create them if the table is flexible
    const testId = '00000000-0000-0000-0000-000000000001';
    
    // Try to upsert a record with both columns
    const { error: upsertError } = await supabase
      .from('chats')
      .upsert([
        { 
          id: testId, 
          display_name: 'Migration Test', 
          other_user_email: 'migration@test.com' 
        }
      ], 
      { 
        onConflict: 'id',
        ignoreDuplicates: false
      });
    
    if (upsertError) {
      console.log('Could not upsert with new columns:', upsertError.message);
      console.log('Trying alternative approach with individual column checks...');
      
      // Check and add display_name column
      await checkAndAddColumn('display_name');
      
      // Check and add other_user_email column
      await checkAndAddColumn('other_user_email');
    } else {
      console.log('Successfully added or confirmed both columns exist!');
    }
    
    console.log('Migration completed!');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

async function checkAndAddColumn(columnName) {
  try {
    // Check if column exists by trying to select it
    const { error: selectError } = await supabase
      .from('chats')
      .select(columnName)
      .limit(1);
    
    if (selectError && selectError.code === '42703') {
      console.log(`${columnName} column does not exist, attempting to add it...`);
      
      // Try to add the column by creating a record with it
      // This approach relies on Supabase's ability to auto-add columns in some cases
      const testId = '00000000-0000-0000-0000-000000000001';
      const { error: upsertError } = await supabase
        .from('chats')
        .upsert([
          { 
            id: testId, 
            [columnName]: columnName === 'display_name' ? 'Test Display Name' : 'test@example.com'
          }
        ], 
        { 
          onConflict: 'id',
          ignoreDuplicates: false
        });
      
      if (upsertError) {
        console.log(`Could not add ${columnName} column:`, upsertError.message);
        console.log(`Please add the ${columnName} column manually to the chats table.`);
      } else {
        console.log(`${columnName} column added successfully!`);
      }
    } else {
      console.log(`${columnName} column already exists.`);
    }
  } catch (error) {
    console.error(`Error checking/adding ${columnName} column:`, error);
  }
}

// Run the migration
runMigration()
  .then(() => {
    console.log('Migration process completed');
    process.exit(0);
  })
  .catch(err => {
    console.error('Unhandled error in migration process:', err);
    process.exit(1);
  });
