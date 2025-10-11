// src/renderer/src/components/AIAssistantPanel.tsx
import React, { useState, useEffect, useRef } from 'react';
import { X, Send, Check, Trash2, MessageSquare } from 'lucide-react';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface AIAssistantPanelProps {
  onClose: () => void;
  onInsertText: (text: string) => void;
  onSetGhostText?: (text: string) => void;
  references: Array<{ id: string; name: string; category: string; content: string }>;
  activeDocument?: { id: string; name: string; content: string | null } | null;
}

const AIAssistantPanel: React.FC<AIAssistantPanelProps> = ({
  onClose,
  onSetGhostText,
  references,
  activeDocument
}) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [paragraphCount, setParagraphCount] = useState(1);
  const [isGenerating, setIsGenerating] = useState(false);
  const [activeTab, setActiveTab] = useState(0);
  const [conversationTabs, setConversationTabs] = useState<string[]>(['Conversation 1']);
  const [aiMode, setAiMode] = useState<'plan' | 'agent'>('plan');
  const [showNotification, setShowNotification] = useState(false);
  const [notificationPreview, setNotificationPreview] = useState<string>('');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

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

    loadHistory();
  }, [activeTab]);

  // Save conversation history to database
  const saveHistory = async (newMessages: Message[]) => {
    try {
      await window.api.settings.set(`ai_conversation_${activeTab}`, JSON.stringify(newMessages));
    } catch (error) {
      console.error('Error saving conversation history:', error);
    }
  };

  // Track which tags are referenced in current input
  const [referencedTags, setReferencedTags] = useState<string[]>([]);

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

      // Build context from active document
      let documentContext = '';
      if (activeDocument && activeDocument.content) {
        try {
          // Parse Slate content and extract text
          const slateContent = JSON.parse(activeDocument.content);
          const extractText = (nodes: any[]): string => {
            return nodes.map(node => {
              if (node.text !== undefined) return node.text;
              if (node.children) return extractText(node.children);
              return '';
            }).join('');
          };
          const docText = extractText(slateContent);

          if (docText.trim()) {
            documentContext = `\n\nCurrent Scene: "${activeDocument.name}"\nContent:\n${docText.substring(0, 2000)}${docText.length > 2000 ? '...' : ''}`;
          }
        } catch (error) {
          console.error('Error parsing active document:', error);
        }
      }

      // Call AI generation with context
      const response = await window.api.ai.generateDirected({
        instruction: cleanText,
        paragraphCount: paragraphCount,
        conversationHistory: messages.slice(-6), // Last 3 exchanges
        referencedNotes: (referencedNotes || '') + documentContext || undefined
      });

      if (aiMode === 'agent') {
        // Agent mode: Send ghost text to editor with brief confirmation
        const confirmMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: "✓ Added to editor as ghost text",
          timestamp: Date.now()
        };

        const updatedMessages = [...newMessages, confirmMessage];
        setMessages(updatedMessages);
        saveHistory(updatedMessages);

        // Send ghost text to editor
        if (onSetGhostText) {
          onSetGhostText(response);
        }

        // Show notification with preview (first 50 characters)
        const preview = response.length > 50 ? response.substring(0, 50) + '...' : response;
        setNotificationPreview(preview);
        setShowNotification(true);
        setTimeout(() => setShowNotification(false), 3000);
      } else {
        // Plan mode: Show response in chat (no accept/reject)
        const assistantMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: response,
          timestamp: Date.now()
        };

        const updatedMessages = [...newMessages, assistantMessage];
        setMessages(updatedMessages);
        saveHistory(updatedMessages);
      }

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
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div style={{
      height: '100%',
      backgroundColor: '#1e1e1e',
      borderLeft: '1px solid #333',
      display: 'flex',
      flexDirection: 'column'
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

      {/* Notification Banner */}
      {showNotification && (
        <div style={{
          padding: '8px 16px',
          backgroundColor: '#4ec9b0',
          color: '#1e1e1e',
          fontSize: '12px',
          fontWeight: 500,
          animation: 'slideDown 0.3s ease-out'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <Check size={14} />
            Ghost text added - Press Tab to accept
          </div>
          {notificationPreview && (
            <div style={{
              fontSize: '11px',
              fontStyle: 'italic',
              opacity: 0.8,
              marginLeft: '22px'
            }}>
              {notificationPreview}
            </div>
          )}
        </div>
      )}

      {/* AI Mode Selector */}
      <div style={{
        padding: '8px 16px',
        borderBottom: '1px solid #333',
        backgroundColor: '#252526',
        display: 'flex',
        alignItems: 'center',
        gap: '12px'
      }}>
        <label style={{ fontSize: '12px', color: '#888', fontWeight: 500 }}>
          Mode:
        </label>
        <select
          value={aiMode}
          onChange={(e) => setAiMode(e.target.value as 'plan' | 'agent')}
          style={{
            padding: '6px 10px',
            backgroundColor: '#1e1e1e',
            border: '1px solid #333',
            borderRadius: '4px',
            color: '#d4d4d4',
            fontSize: '12px',
            cursor: 'pointer',
            flex: 1
          }}
        >
          <option value="plan">Plan - Ideas & Feedback</option>
          <option value="agent">Agent - Ghost Text Edits</option>
        </select>
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
            onChange={(e) => {
              const newValue = e.target.value;
              setInputText(newValue);

              // Update referenced tags
              const tagRegex = /#(\w+)/g;
              const matches = newValue.match(tagRegex);
              if (matches) {
                const foundTags = matches.map(tag => tag.slice(1));
                setReferencedTags(foundTags);
              } else {
                setReferencedTags([]);
              }
            }}
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

        {/* Context Indicator */}
        <div style={{
          fontSize: '10px',
          color: '#666',
          marginTop: '6px',
          marginBottom: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: '4px'
        }}>
          <div>Press Enter to send • Shift+Enter for new line</div>

          {(activeDocument || referencedTags.length > 0) && (
            <div style={{
              padding: '4px 6px',
              backgroundColor: '#1e1e1e',
              borderRadius: '3px',
              fontSize: '10px',
              color: '#888'
            }}>
              <strong style={{ color: '#aaa' }}>Context:</strong>{' '}
              {activeDocument && (
                <span style={{ color: '#4ec9b0' }}>
                  {activeDocument.name}
                </span>
              )}
              {activeDocument && referencedTags.length > 0 && <span> • </span>}
              {referencedTags.length > 0 && (
                <span style={{ color: '#ce9178' }}>
                  {referencedTags.map(tag => `#${tag}`).join(', ')}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AIAssistantPanel;
