require('dotenv').config({ path: './server/.env' });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function test() {
  const { data, error } = await supabase
    .from('molecule_scores')
    .upsert([{
      smiles: 'C1=CC=CC=C1',
      molecule_name: 'Benzene',
      mw: 78.11,
      logp: 2.13,
      hbd: 0,
      hba: 0,
      rotatable_bonds: 0,
      druglikeness_score: 1,
      complementarity_score: 0.1,
      composite_score: 0.5,
      is_known_reference: true,
      scored_by_user_id: null
    }], { onConflict: 'smiles' });
    
  if (error) {
    console.error("Error inserting:", error);
  } else {
    console.log("Successfully inserted test molecule into Supabase!");
    
    // Now verify we can read it back
    const { data: readData, error: readError } = await supabase
      .from('molecule_scores')
      .select('*')
      .limit(1);
    console.log("Read back:", readData);
  }
}

test();
