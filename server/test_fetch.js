const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function test() {
  const { data, error } = await supabase.from('molecule_scores').select('*').limit(5);
  console.log("Error:", error);
  console.log("Data length:", data ? data.length : 0);
  console.log("Data:", data);
}
test();
