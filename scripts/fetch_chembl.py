import requests
import json
import os
import sys

DATA_DIR = os.path.join(os.path.dirname(__file__), '..', 'server', 'data')
LIB_PATH = os.path.join(DATA_DIR, 'molecule_library.json')
TARGET_COUNT = 10000

def fetch_chembl_smiles():
    print(f"Fetching up to {TARGET_COUNT} drug-like SMILES from ChEMBL...")
    
    # We want small molecules that are approved drugs (max_phase 4) or at least in trials.
    # We'll just ask for small molecules, max_phase = 4 (approved). 
    # If there aren't 10,000, we'll lower the phase constraint.
    # Actually, ChEMBL has ~3000 max_phase=4. Let's ask for max_phase >= 1.
    
    url = "https://www.ebi.ac.uk/chembl/api/data/molecule"
    params = {
        "molecule_type": "Small molecule",
        "max_phase__gte": 1,
        "format": "json",
        "limit": 1000,
        "offset": 0
    }
    
    collected_smiles = set()
    molecules_to_add = []
    
    while len(molecules_to_add) < TARGET_COUNT:
        print(f"Requesting offset {params['offset']}...")
        resp = requests.get(url, params=params)
        if resp.status_code != 200:
            print(f"Failed to fetch data: {resp.status_code}")
            break
            
        data = resp.json()
        mols = data.get('molecules', [])
        if not mols:
            print("No more molecules found.")
            break
            
        for m in mols:
            struct = m.get('molecule_structures')
            if struct and struct.get('canonical_smiles'):
                smiles = struct.get('canonical_smiles')
                pref_name = m.get('pref_name') or m.get('molecule_chembl_id')
                if smiles not in collected_smiles:
                    collected_smiles.add(smiles)
                    molecules_to_add.append({
                        "smiles": smiles,
                        "name": pref_name,
                        "source": "ChEMBL"
                    })
                    
            if len(molecules_to_add) >= TARGET_COUNT:
                break
                
        params['offset'] += params['limit']
        
    print(f"Fetched {len(molecules_to_add)} unique SMILES.")
    return molecules_to_add

def update_library(new_mols):
    if not os.path.exists(LIB_PATH):
        print(f"Library file {LIB_PATH} not found!")
        return

    with open(LIB_PATH, 'r') as f:
        data = json.load(f)
        
    existing_mols = data.get('molecules', [])
    
    # Separate controls from decoys based on name
    controls = [m for m in existing_mols if m.get('name') and '(Control)' in m.get('name')]
    
    # We want exactly the controls + 10,000 decoys = ~10,003 molecules.
    
    print(f"Found {len(controls)} controls.")
    
    # Update data
    data['molecules'] = controls + new_mols
    
    with open(LIB_PATH, 'w') as f:
        json.dump(data, f, indent=2)
        
    print(f"Library updated with {len(data['molecules'])} total molecules.")

if __name__ == "__main__":
    new_mols = fetch_chembl_smiles()
    update_library(new_mols)
