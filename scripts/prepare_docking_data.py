import json
import os
import requests
from rdkit import Chem
from rdkit.Chem import AllChem
from meeko import MoleculePreparation

DATA_DIR = os.path.join(os.path.dirname(__file__), '..', 'server', 'data')
LIB_PATH = os.path.join(DATA_DIR, 'molecule_library.json')
TARGET_PDB = '1pwc'
PDB_URL = f'https://files.rcsb.org/download/{TARGET_PDB}.pdb'

def download_and_prepare_receptor():
    print(f"Downloading PDB {TARGET_PDB}...")
    resp = requests.get(PDB_URL)
    resp.raise_for_status()
    pdb_text = resp.text

    print("Cleaning PDB (removing water and ligands)...")
    clean_lines = []
    for line in pdb_text.splitlines():
        if line.startswith('ATOM') or line.startswith('TER'):
            # Only keep standard protein atoms, maybe filter out alternative locations
            if line[17:20].strip() in ['ALA', 'ARG', 'ASN', 'ASP', 'CYS', 'GLN', 'GLU', 'GLY', 'HIS', 'ILE', 'LEU', 'LYS', 'MET', 'PHE', 'PRO', 'SER', 'THR', 'TRP', 'TYR', 'VAL']:
                clean_lines.append(line)
    
    clean_pdb = '\n'.join(clean_lines)
    
    # Compute bounding box for active site docking (using co-crystallized ligand)
    ligand_x, ligand_y, ligand_z = [], [], []
    for line in pdb_text.splitlines():
        if line.startswith('HETATM') and 'APN' in line:
            x = float(line[30:38].strip())
            y = float(line[38:46].strip())
            z = float(line[46:54].strip())
            ligand_x.append(x)
            ligand_y.append(y)
            ligand_z.append(z)
            
    if ligand_x:
        center_x = sum(ligand_x) / len(ligand_x)
        center_y = sum(ligand_y) / len(ligand_y)
        center_z = sum(ligand_z) / len(ligand_z)
        
        box_config = {
            "center_x": round(center_x, 3),
            "center_y": round(center_y, 3),
            "center_z": round(center_z, 3),
            "size_x": 22.0,
            "size_y": 22.0,
            "size_z": 22.0
        }
        
        box_path = os.path.join(DATA_DIR, 'box_config.json')
        with open(box_path, 'w') as f:
            json.dump(box_config, f, indent=2)
        print(f"Saved active site box config to {box_path}")

    # Require Meeko for proper PDBQT preparation
    try:
        from meeko import ReceptorPreparation
        print("Preparing receptor PDBQT with Meeko...")
        prep = ReceptorPreparation()
        prep.merge_hydrogens = False
        pdbqt_str = prep.prepare(clean_pdb)
        if isinstance(pdbqt_str, tuple):
            pdbqt_str = pdbqt_str[0]
    except Exception as e:
        print(f"Meeko ReceptorPreparation failed: {e}")
        import sys
        sys.exit(1)
        
    receptor_path = os.path.join(DATA_DIR, 'receptor.pdbqt')
    with open(receptor_path, 'w') as f:
        f.write(pdbqt_str)
    print(f"Saved receptor to {receptor_path}")

def prepare_ligands():
    print("Loading molecule library...")
    with open(LIB_PATH, 'r') as f:
        data = json.load(f)
        
    molecules = data.get('molecules', [])
    print(f"Found {len(molecules)} molecules. Converting to 3D PDBQT...")
    
    valid_molecules = []
    
    for i, mol_data in enumerate(molecules):
        smiles = mol_data.get('smiles')
        if not smiles:
            continue
            
        mol = Chem.MolFromSmiles(smiles)
        if not mol:
            continue
            
        mol = Chem.AddHs(mol)
        try:
            # Generate 3D conformer
            if AllChem.EmbedMolecule(mol, randomSeed=42) != 0:
                print(f"Failed to embed {smiles}")
                continue
            # Optimize conformer
            AllChem.MMFFOptimizeMolecule(mol)
        except Exception:
            continue
            
        try:
            preparator = MoleculePreparation(merge_these_atom_types=("H",))
            preparator.prepare(mol)
            pdbqt_string = preparator.write_pdbqt_string()
            mol_data['pdbqt'] = pdbqt_string
            valid_molecules.append(mol_data)
        except Exception as e:
            print(f"Failed to prepare {smiles}: {e}")
            continue
            
        if (i+1) % 100 == 0:
            print(f"Processed {i+1}/{len(molecules)}")
            
    data['molecules'] = valid_molecules
    
    print(f"Saving updated library with {len(valid_molecules)} valid 3D ligands...")
    with open(LIB_PATH, 'w') as f:
        json.dump(data, f, indent=2)

if __name__ == "__main__":
    download_and_prepare_receptor()
    prepare_ligands()
    print("Done!")
