/**
 * Basic JS Tokenizer for TinyLlama.
 * Loads the tokenizer_export.json format.
 */

export class Tokenizer {
  constructor(exportData) {
    this.vocab = exportData.vocab;
    this.idToToken = {};
    for (const [token, id] of Object.entries(this.vocab)) {
      this.idToToken[id] = token;
    }
    
    // For Llama/Sentencepiece, space is represented as   (U+2581)
    this.SPACE_CHAR = ' ';
    
    this.bosId = exportData.bos_token_id || 1;
    this.eosId = exportData.eos_token_id || 2;
  }

  // Very naive longest-prefix match tokenizer (since implementing full SentencePiece in 100 lines is tricky).
  // This is just a polyfill to get us off the ground without external libraries.
  encode(text) {
    // Convert spaces to   and add BOS
    let processed = text.replace(/ /g, this.SPACE_CHAR);
    // Add dummy prefix space that Llama tokenizers usually expect
    if (!processed.startsWith(this.SPACE_CHAR)) {
      processed = this.SPACE_CHAR + processed;
    }

    const tokens = [this.bosId];
    
    let i = 0;
    while (i < processed.length) {
      let matchId = null;
      let matchLen = 0;
      
      // Greedily find the longest matching substring in our vocab
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
        // Fallback: character by character if no match (usually byte fallback)
        // For simplicity, just skip unknown characters or use unk token
        tokens.push(this.vocab['<unk>'] || 0);
        i++;
      }
    }
    
    return tokens;
  }

  decode(tokenIds) {
    let text = '';
    for (const id of tokenIds) {
      if (id === this.bosId || id === this.eosId) continue;
      
      let token = this.idToToken[id] || '';
      
      // Handle byte fallback tokens like <0x0A>
      if (token.startsWith('<0x') && token.endsWith('>')) {
        const hex = token.substring(3, 5);
        token = String.fromCharCode(parseInt(hex, 16));
      }
      
      text += token;
    }
    return text.replace(new RegExp(this.SPACE_CHAR, 'g'), ' ');
  }

  applyChatTemplate(prompt) {
    // TinyLlama Chat Template:
    // <|system|>
    // {system_message}</s>
    // <|user|>
    // {prompt}</s>
    // <|assistant|>
    return `<|system|>\nYou are a helpful AI assistant.</s>\n<|user|>\n${prompt}</s>\n<|assistant|>\n`;
  }
}
