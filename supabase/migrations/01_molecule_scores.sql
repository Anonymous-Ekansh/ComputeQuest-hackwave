-- Create the molecule_scores table
CREATE TABLE molecule_scores (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  smiles text NOT NULL UNIQUE,
  molecule_name text,
  mw numeric,
  logp numeric,
  hbd numeric,
  hba numeric,
  rotatable_bonds numeric,
  druglikeness_score numeric,
  complementarity_score numeric,
  composite_score numeric,
  is_known_reference boolean DEFAULT false,
  scored_by_user_id text,  -- Google user ID (no FK — user may not exist in users table yet)
  scored_at timestamptz DEFAULT now()
);

-- Index for fast leaderboard sorting
CREATE INDEX idx_molecule_scores_composite_score_desc ON molecule_scores(composite_score DESC);

-- Enable RLS
ALTER TABLE molecule_scores ENABLE ROW LEVEL SECURITY;

-- Allow anyone to read leaderboard
CREATE POLICY "Anyone can view molecule scores" ON molecule_scores FOR SELECT USING (true);

-- Allow inserts and updates (Node server uses service key)
CREATE POLICY "Server can insert molecule scores" ON molecule_scores FOR INSERT WITH CHECK (true);
CREATE POLICY "Server can update molecule scores" ON molecule_scores FOR UPDATE USING (true) WITH CHECK (true);
