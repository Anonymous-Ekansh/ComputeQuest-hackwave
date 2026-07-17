const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://wammblbodauhydrlwfwt.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndhbW1ibGJvZGF1aHlkcmx3Znd0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MzAwNTkwMywiZXhwIjoyMDk4NTgxOTAzfQ.mLEykMPE9Xvqe3eukMb_oxDYPGkXJOUuk8aCeT45m_I';

const supabase = createClient(supabaseUrl, supabaseKey);

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
