/**
 * server/src/tokenizer.js
 * 
 * Server-side tokenizer for TinyLlama.
 * Used to apply the chat template and encode the initial prompt 
 * before sending it to the pipeline nodes.
 */

const fs = require('fs');
const path = require('path');

class Tokenizer {
  constructor(exportPath) {
    if (!fs.existsSync(exportPath)) {
      throw new Error(`Tokenizer export not found at ${exportPath}`);
    }
    const exportData = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
    this.vocab = exportData.vocab;
    this.idToToken = {};
    for (const [token, id] of Object.entries(this.vocab)) {
      this.idToToken[id] = token;
    }
    
    // For Llama/Sentencepiece, space is represented as   (U+2581)
    this.SPACE_CHAR = '\u2581';
    
    this.bosId = exportData.bos_token_id || 1;
    this.eosId = exportData.eos_token_id || 2;
  }

  encode(text) {
    let processed = text.replace(/ /g, this.SPACE_CHAR);
    if (!processed.startsWith(this.SPACE_CHAR)) {
      processed = this.SPACE_CHAR + processed;
    }

    const tokens = [this.bosId];
    let i = 0;
    while (i < processed.length) {
      let matchId = null;
      let matchLen = 0;
      
      for (let len = processed.length - i; len > 0; len--) {
        const sub = processed.substring(i, i + len);
        if (this.vocab[sub] !== undefined) {
          matchId = this.vocab[sub];
          matchLen = len;
          break;
        }
      }
      
      if (matchId !== null) {
        tokens.push(matchId);
        i += matchLen;
      } else {
        tokens.push(this.vocab['<unk>'] || 0);
        i++;
      }
    }
    return tokens;
  }

  decode(tokenIds) {
    const bytes = [];
    let text = '';
    
    // Helper to decode accumulated bytes
    const flushBytes = () => {
      if (bytes.length > 0) {
        text += new TextDecoder('utf-8').decode(new Uint8Array(bytes));
        bytes.length = 0;
      }
    };

    for (const id of tokenIds) {
      if (id === this.bosId || id === this.eosId) continue;
      let token = this.idToToken[id] || '';
      if (token.startsWith('<0x') && token.endsWith('>')) {
        const hex = token.substring(3, 5);
        bytes.push(parseInt(hex, 16));
      } else {
        flushBytes();
        text += token;
      }
    }
    flushBytes();
    
    return text.replace(new RegExp(this.SPACE_CHAR, 'g'), ' ');
  }

  applyChatTemplate(prompt) {
    return `<|system|>\nYou are a helpful AI assistant.</s>\n<|user|>\n${prompt}</s>\n<|assistant|>\n`;
  }
}

// Singleton instance to be initialized once
let _instance = null;

function getTokenizer() {
  if (!_instance) {
    const exportPath = path.join(__dirname, '..', 'models', 'tokenizer', 'tokenizer_export.json');
    _instance = new Tokenizer(exportPath);
  }
  return _instance;
}

module.exports = {
  getTokenizer,
  Tokenizer
};
