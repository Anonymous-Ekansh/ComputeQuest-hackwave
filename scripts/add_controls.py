import json
import os
from rdkit import Chem
from rdkit.Chem import AllChem
from meeko import MoleculePreparation

DATA_DIR = os.path.join(os.path.dirname(__file__), '..', 'server', 'data')
LIB_PATH = os.path.join(DATA_DIR, 'molecule_library.json')

CONTROLS = [
    {
        "smiles": "CC1([C@@H](N2[C@H](S1)[C@@H](C2=O)NC(=O)Cc3ccccc3)C(=O)O)C",
        "name": "Penicillin G (Control)"
    },
    {
        "smiles": "CC1([C@@H](N2[C@H](S1)[C@@H](C2=O)NC(=O)[C@@H](c3ccccc3)N)C(=O)O)C",
        "name": "Ampicillin (Control)"
    },
    {
        "smiles": "CC1([C@@H](N2[C@H](S1)[C@@H](C2=O)NC(=O)[C@@H](c3ccc(O)cc3)N)C(=O)O)C",
        "name": "Amoxicillin (Control)"
    }
]

def main():
    print("Loading library...")
    with open(LIB_PATH, 'r') as f:
        data = json.load(f)
        
    molecules = data.get('molecules', [])
    
    # Check if already added
    existing_smiles = {m.get('smiles') for m in molecules}
    
    new_molecules = []
    
    for c in CONTROLS:
        if c['smiles'] in existing_smiles:
            print(f"Skipping {c['name']}, already in library.")
            continue
            
        print(f"Preparing {c['name']}...")
        mol = Chem.MolFromSmiles(c['smiles'])
        mol = Chem.AddHs(mol)
        
        try:
            if AllChem.EmbedMolecule(mol, randomSeed=42) != 0:
                print(f"Failed to embed {c['name']}")
                continue
            AllChem.MMFFOptimizeMolecule(mol)
            
            preparator = MoleculePreparation(merge_these_atom_types=("H",))
            preparator.prepare(mol)
            pdbqt_string = preparator.write_pdbqt_string()
            
            c['pdbqt'] = pdbqt_string
            new_molecules.append(c)
            print(f"Successfully prepared {c['name']}")
        except Exception as e:
            print(f"Failed to prepare {c['name']}: {e}")
            
    if new_molecules:
        # Prepend so they get evaluated first
        data['molecules'] = new_molecules + molecules
        with open(LIB_PATH, 'w') as f:
            json.dump(data, f, indent=2)
        print(f"Added {len(new_molecules)} control molecules to the library.")
    else:
        print("No new controls added.")

if __name__ == "__main__":
    main()
