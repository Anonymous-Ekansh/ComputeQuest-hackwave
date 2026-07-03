require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://wammblbodauhydrlwfwt.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndhbW1ibGJvZGF1aHlkcmx3Znd0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwMDU5MDMsImV4cCI6MjA5ODU4MTkwM30.IDLDnCvaFcWwthdP_O2zBM6usrwduJLdkWq5qz5QhNY';

const supabase = createClient(supabaseUrl, supabaseKey);

async function test() {
  console.log('Testing Supabase Connection...');
  
  // Test Read
  console.log('1. Reading users...');
  const { data: readData, error: readError } = await supabase.from('users').select('*');
  if (readError) {
    console.error('Read Error:', readError);
  } else {
    console.log('Read Success:', readData);
  }

  // Test Write
  console.log('2. Writing dummy user...');
  const { data: writeData, error: writeError } = await supabase.from('users').upsert([
    { id: 'test-id-123', username: 'TestUser', credits: 0, total_contributed: 0 }
  ], { onConflict: 'id' });
  
  if (writeError) {
    console.error('Write Error:', writeError);
  } else {
    console.log('Write Success!');
  }
}

test();
