require('dotenv').config({ path: './server/.env' });
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
async function test() {
  const { data, error } = await supabase.from('users').upsert([
    { id: '123456', username: 'Test', credits: 0, total_contributed: 0 }
  ], { onConflict: 'id' });
  console.log('Error:', error);
  console.log('Data:', data);
}
test();
