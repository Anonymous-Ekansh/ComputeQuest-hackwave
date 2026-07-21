import json
import os
import requests
import multiprocessing
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

def process_molecule(mol_data):
    smiles = mol_data.get('smiles')
    if not smiles:
        return None
        
    mol = Chem.MolFromSmiles(smiles)
    if not mol:
        return None
        
    mol = Chem.AddHs(mol)
    try:
        # Generate 3D conformer
        if AllChem.EmbedMolecule(mol, randomSeed=42) != 0:
            return None
        # Optimize conformer
        AllChem.MMFFOptimizeMolecule(mol)
    except Exception:
        return None
        
    try:
        preparator = MoleculePreparation(merge_these_atom_types=("H",))
        preparator.prepare(mol)
        pdbqt_string = preparator.write_pdbqt_string()
        mol_data['pdbqt'] = pdbqt_string
        return mol_data
    except Exception as e:
        return None

def prepare_ligands():
    print("Loading molecule library...")
    with open(LIB_PATH, 'r') as f:
        data = json.load(f)
        
    molecules = data.get('molecules', [])
    print(f"Found {len(molecules)} molecules. Converting to 3D PDBQT using multiprocessing...")
    
    valid_molecules = []
    
    # We already have some molecules with pdbqt if we didn't want to recompute, 
    # but the script traditionally recomputes. Let's just process those without pdbqt
    # or just process all. Let's process those without pdbqt to save massive time.
    
    mols_to_process = [m for m in molecules if not m.get('pdbqt')]
    mols_already_done = [m for m in molecules if m.get('pdbqt')]
    
    print(f"{len(mols_already_done)} molecules already have 3D conformers. {len(mols_to_process)} need processing.")
    
    if mols_to_process:
        num_cores = max(1, multiprocessing.cpu_count() - 1)
        print(f"Using {num_cores} CPU cores...")
        
        with multiprocessing.Pool(processes=num_cores) as pool:
            results = []
            for i, res in enumerate(pool.imap_unordered(process_molecule, mols_to_process, chunksize=100)):
                if res is not None:
                    results.append(res)
                if (i + 1) % 500 == 0:
                    print(f"Processed {i + 1}/{len(mols_to_process)} molecules...")
                    
        valid_molecules = mols_already_done + results
    else:
        valid_molecules = mols_already_done
            
    data['molecules'] = valid_molecules
    
    print(f"Saving updated library with {len(valid_molecules)} valid 3D ligands...")
    with open(LIB_PATH, 'w') as f:
        json.dump(data, f, indent=2)

if __name__ == "__main__":
    # download_and_prepare_receptor()
    prepare_ligands()
    print("Done!")
