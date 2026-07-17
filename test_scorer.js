const { scoreMolecule } = require('./server/src/molecularScorer');
const fs = require('fs');
const target = JSON.parse(fs.readFileSync('./server/data/target.json'));
scoreMolecule('CC(C)(C)c1ccc2occ(CC(=O)Nc3ccccc3F)c2c1', target).then(res => {
  console.log("Scoring result:", res);
}).catch(console.error);
