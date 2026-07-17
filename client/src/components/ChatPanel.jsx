import React, { useState, useEffect, useRef } from 'react';
import './ChatPanel.css';

export default function ChatPanel({ socket }) {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    if (!socket) return;

    const handleFinalToken = ({ sessionId, tokenId, tokenText }) => {
      setMessages(prev => {
        const newMsgs = [...prev];
        const lastMsg = newMsgs[newMsgs.length - 1];
        if (lastMsg && lastMsg.role === 'assistant') {
          if (tokenText) {
            lastMsg.content += tokenText;
          }
        }
        return newMsgs;
      });
    };

    const handlePipelineEnd = () => {
      setIsGenerating(false);
    };

    const handleGenerationError = ({ reason }) => {
      setMessages(prev => [
        ...prev, 
        { role: 'system', content: `Error: ${reason}` }
      ]);
      setIsGenerating(false);
    };

    const handleGenerationWarning = ({ warning }) => {
      setMessages(prev => [
        ...prev, 
        { role: 'system', content: `Warning: ${warning}` }
      ]);
    };

    socket.on('final_token', handleFinalToken);
    socket.on('pipeline_end', handlePipelineEnd);
    socket.on('generation_error', handleGenerationError);
    socket.on('generation_warning', handleGenerationWarning);

    return () => {
      socket.off('final_token', handleFinalToken);
      socket.off('pipeline_end', handlePipelineEnd);
      socket.off('generation_error', handleGenerationError);
      socket.off('generation_warning', handleGenerationWarning);
    };
  }, [socket]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!input.trim() || isGenerating) return;

    const promptText = input.trim();
    setMessages(prev => [
      ...prev,
      { role: 'user', content: promptText },
      { role: 'assistant', content: '' }
    ]);
    setInput('');
    setIsGenerating(true);

    const sessionId = Date.now().toString();
    socket.emit('start_generation', { sessionId, prompt: promptText });
  };

  return (
    <div className="chat-panel">
      <div className="chat-history">
        {messages.length === 0 && (
          <div className="chat-placeholder">
            <h2>HACKWAVE LLM</h2>
            <p>Start a distributed generation.</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`chat-message ${msg.role}`}>
            <div className="msg-avatar">{msg.role === 'user' ? 'U' : (msg.role === 'system' ? '!' : 'AI')}</div>
            <div className="msg-content">{msg.content}</div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      
      <form className="chat-input-area" onSubmit={handleSubmit}>
        <input 
          type="text" 
          className="chat-input" 
          value={input} 
          onChange={e => setInput(e.target.value)} 
          placeholder="Ask the cluster..." 
          disabled={isGenerating}
        />
        <button type="submit" className="chat-send-btn" disabled={isGenerating || !input.trim()}>
          {isGenerating ? 'Computing...' : 'Send'}
        </button>
      </form>
    </div>
  );
}
