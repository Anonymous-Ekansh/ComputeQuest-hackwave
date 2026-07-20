import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: 'server/.env' });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const { data, error } = await supabase.from('users').select('id, username, credits, total_contributed, trophies, can_upgrade');
console.log("Error:", error);
console.log("Data:", data);
