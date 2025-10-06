// src/renderer/src/components/AIAssistantPanel.tsx
import React, { useState, useEffect, useRef } from 'react';
import { X, Send, RotateCcw, Check, Trash2, MessageSquare } from 'lucide-react';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface PendingInsertion {
  id: string;
  content: string;
  position: number; // Position in the document where it should be inserted
}

interface AIAssistantPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onInsertText: (text: string) => void;
  references: Array<{ id: string; name: string; category: string; content: string }>;
}

const AIAssistantPanel: React.FC<AIAssistantPanelProps> = ({
  isOpen,
  onClose,
  onInsertText,
  references
}) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [paragraphCount, setParagraphCount] = useState(1);
  const [isGenerating, setIsGenerating] = useState(false);
  const [pendingInsertion, setPendingInsertion] = useState<PendingInsertion | null>(null);
  const [activeTab, setActiveTab] = useState(0);
  const [conversationTabs, setConversationTabs] = useState<string[]>(['Conversation 1']);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  // Load conversation history from database
  useEffect(() => {
    const loadHistory = async () => {
      try {
        const historyJson = await window.api.settings.get(`ai_conversation_${activeTab}`);
        if (historyJson) {
          const history = JSON.parse(historyJson);
          setMessages(history);
        } else {
          setMessages([]);
        }
      } catch (error) {
        console.error('Error loading conversation history:', error);
        setMessages([]);
      }
    };

    if (isOpen) {
      loadHistory();
    }
  }, [isOpen, activeTab]);

  // Save conversation history to database
  const saveHistory = async (newMessages: Message[]) => {
    try {
      await window.api.settings.set(`ai_conversation_${activeTab}`, JSON.stringify(newMessages));
    } catch (error) {
      console.error('Error saving conversation history:', error);
    }
  };

  // Parse #tags from input text
  const parseReferenceTags = (text: string): { cleanText: string; referencedNotes: string } => {
    const tagRegex = /#(\w+)/g;
    const matches = text.match(tagRegex);

    if (!matches) {
      return { cleanText: text, referencedNotes: '' };
    }

    let referencedNotes = '';
    matches.forEach(tag => {
      const tagName = tag.slice(1); // Remove #
      const reference = references.find(ref =>
        ref.name.toLowerCase() === tagName.toLowerCase()
      );

      if (reference) {
        referencedNotes += `\n\n${reference.category.toUpperCase()} - ${reference.name}:\n${reference.content}`;
      }
    });

    return { cleanText: text, referencedNotes };
  };

  const handleSend = async () => {
    if (!inputText.trim() || isGenerating) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: inputText,
      timestamp: Date.now()
    };

    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    saveHistory(newMessages);

    setIsGenerating(true);
    setInputText('');

    try {
      // Parse tags and get referenced notes
      const { cleanText, referencedNotes } = parseReferenceTags(inputText);

      // Call AI generation with context
      const response = await window.api.ai.generateDirected({
        instruction: cleanText,
        paragraphCount: paragraphCount,
        conversationHistory: messages.slice(-6), // Last 3 exchanges
        referencedNotes: referencedNotes || undefined
      });

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: response,
        timestamp: Date.now()
      };

      const updatedMessages = [...newMessages, assistantMessage];
      setMessages(updatedMessages);
      saveHistory(updatedMessages);

      // Set as pending insertion
      setPendingInsertion({
        id: assistantMessage.id,
        content: response,
        position: 0 // Will be set to current cursor position
      });

    } catch (error) {
      console.error('Error generating AI response:', error);
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `Error: ${error instanceof Error ? error.message : 'Failed to generate response'}`,
        timestamp: Date.now()
      };
      const updatedMessages = [...newMessages, errorMessage];
      setMessages(updatedMessages);
      saveHistory(updatedMessages);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleAccept = () => {
    if (pendingInsertion) {
      onInsertText(pendingInsertion.content);
      setPendingInsertion(null);
    }
  };

  const handleRegenerate = async () => {
    if (messages.length < 2) return;

    // Remove last assistant message and regenerate
    const lastUserMessage = messages[messages.length - 2];
    const trimmedMessages = messages.slice(0, -1);
    setMessages(trimmedMessages);
    setPendingInsertion(null);

    setInputText(lastUserMessage.content);
    // Will trigger regeneration on next send
  };

  const handleDiscard = () => {
    // Remove last assistant message
    if (messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
      const trimmedMessages = messages.slice(0, -1);
      setMessages(trimmedMessages);
      saveHistory(trimmedMessages);
    }
    setPendingInsertion(null);
  };

  const handleNewTab = () => {
    const newTabIndex = conversationTabs.length;
    setConversationTabs([...conversationTabs, `Conversation ${newTabIndex + 1}`]);
    setActiveTab(newTabIndex);
    setMessages([]);
  };

  const handleClearConversation = async () => {
    if (confirm('Clear this conversation? This cannot be undone.')) {
      setMessages([]);
      await window.api.settings.set(`ai_conversation_${activeTab}`, JSON.stringify([]));
      setPendingInsertion(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed',
      bottom: '20px',
      right: '20px',
      width: '400px',
      height: '600px',
      backgroundColor: '#1e1e1e',
      border: '1px solid #333',
      borderRadius: '8px',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 1000,
      boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)'
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid #333',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: '#252526'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <MessageSquare size={18} color="#dcb67a" />
          <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>AI Assistant</h3>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            onClick={handleClearConversation}
            title="Clear conversation"
            style={{
              backgroundColor: 'transparent',
              border: 'none',
              color: '#888',
              cursor: 'pointer',
              padding: '4px',
              display: 'flex'
            }}
          >
            <Trash2 size={16} />
          </button>
          <button
            onClick={onClose}
            style={{
              backgroundColor: 'transparent',
              border: 'none',
              color: '#888',
              cursor: 'pointer',
              padding: '4px',
              display: 'flex'
            }}
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Conversation Tabs */}
      <div style={{
        display: 'flex',
        gap: '4px',
        padding: '8px',
        borderBottom: '1px solid #333',
        backgroundColor: '#252526',
        overflowX: 'auto'
      }}>
        {conversationTabs.map((tab, index) => (
          <button
            key={index}
            onClick={() => setActiveTab(index)}
            style={{
              padding: '6px 12px',
              backgroundColor: activeTab === index ? '#0e639c' : '#333',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '12px',
              whiteSpace: 'nowrap'
            }}
          >
            {tab}
          </button>
        ))}
        <button
          onClick={handleNewTab}
          style={{
            padding: '6px 12px',
            backgroundColor: '#333',
            color: '#888',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '12px'
          }}
        >
          +
        </button>
      </div>

      {/* Messages */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px'
      }}>
        {messages.length === 0 && (
          <div style={{
            textAlign: 'center',
            color: '#666',
            fontSize: '13px',
            marginTop: '40px'
          }}>
            <p>Ask the AI to help with your writing!</p>
            <p style={{ fontSize: '11px', marginTop: '8px' }}>
              Try: "Make them kiss" or "Add 2 paragraphs of action"
            </p>
            <p style={{ fontSize: '11px', marginTop: '8px' }}>
              Use #CharacterName to reference your notes
            </p>
          </div>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            style={{
              alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '85%'
            }}
          >
            <div style={{
              padding: '10px 14px',
              backgroundColor: message.role === 'user' ? '#0e639c' : '#2d2d30',
              borderRadius: '8px',
              fontSize: '13px',
              lineHeight: '1.5',
              color: '#d4d4d4',
              wordWrap: 'break-word'
            }}>
              {message.content}
            </div>
            {message.role === 'assistant' && pendingInsertion?.id === message.id && (
              <div style={{
                display: 'flex',
                gap: '6px',
                marginTop: '6px',
                justifyContent: 'flex-start'
              }}>
                <button
                  onClick={handleAccept}
                  title="Accept and insert"
                  style={{
                    padding: '4px 8px',
                    backgroundColor: '#0e639c',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '11px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px'
                  }}
                >
                  <Check size={12} /> Accept
                </button>
                <button
                  onClick={handleRegenerate}
                  title="Regenerate"
                  style={{
                    padding: '4px 8px',
                    backgroundColor: '#333',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '11px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px'
                  }}
                >
                  <RotateCcw size={12} /> Regenerate
                </button>
                <button
                  onClick={handleDiscard}
                  title="Discard"
                  style={{
                    padding: '4px 8px',
                    backgroundColor: '#333',
                    color: '#888',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '11px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px'
                  }}
                >
                  <X size={12} /> Discard
                </button>
              </div>
            )}
          </div>
        ))}

        {isGenerating && (
          <div style={{
            alignSelf: 'flex-start',
            padding: '10px 14px',
            backgroundColor: '#2d2d30',
            borderRadius: '8px',
            fontSize: '13px',
            color: '#888'
          }}>
            Generating...
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div style={{
        borderTop: '1px solid #333',
        padding: '12px',
        backgroundColor: '#252526'
      }}>
        {/* Paragraph count selector */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginBottom: '8px'
        }}>
          <label style={{ fontSize: '12px', color: '#888' }}>
            Paragraphs:
          </label>
          <input
            type="number"
            min="1"
            max="10"
            value={paragraphCount}
            onChange={(e) => setParagraphCount(Number(e.target.value))}
            style={{
              width: '50px',
              padding: '4px 8px',
              backgroundColor: '#1e1e1e',
              border: '1px solid #333',
              borderRadius: '4px',
              color: '#d4d4d4',
              fontSize: '12px'
            }}
          />
        </div>

        {/* Input and send */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
          <textarea
            ref={inputRef}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="What should happen next? (Use #Name for references)"
            disabled={isGenerating}
            style={{
              flex: 1,
              minHeight: '60px',
              maxHeight: '120px',
              padding: '8px',
              backgroundColor: '#1e1e1e',
              border: '1px solid #333',
              borderRadius: '4px',
              color: '#d4d4d4',
              fontSize: '13px',
              fontFamily: 'inherit',
              resize: 'vertical'
            }}
          />
          <button
            onClick={handleSend}
            disabled={isGenerating || !inputText.trim()}
            style={{
              padding: '10px 12px',
              backgroundColor: isGenerating || !inputText.trim() ? '#333' : '#0e639c',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: isGenerating || !inputText.trim() ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '13px'
            }}
          >
            <Send size={16} />
          </button>
        </div>

        <p style={{ fontSize: '10px', color: '#666', marginTop: '6px', marginBottom: 0 }}>
          Press Enter to send • Shift+Enter for new line
        </p>
      </div>
    </div>
  );
};

export default AIAssistantPanel;
