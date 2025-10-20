// src/renderer/src/components/Toast.tsx
import React, { useEffect } from 'react';
import { CheckCircle, XCircle, AlertCircle, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

interface ToastProps {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
  onClose: (id: string) => void;
}

const Toast: React.FC<ToastProps> = ({ id, type, message, duration = 4000, onClose }) => {
  useEffect(() => {
    if (duration > 0) {
      const timer = setTimeout(() => {
        onClose(id);
      }, duration);

      return () => clearTimeout(timer);
    }
  }, [id, duration, onClose]);

  const getIcon = () => {
    switch (type) {
      case 'success':
        return <CheckCircle size={20} color="#4ade80" />;
      case 'error':
        return <XCircle size={20} color="#f87171" />;
      case 'warning':
        return <AlertCircle size={20} color="#fbbf24" />;
      case 'info':
        return <Info size={20} color="#60a5fa" />;
    }
  };

  const getBackgroundColor = () => {
    switch (type) {
      case 'success':
        return '#1e3a1e';
      case 'error':
        return '#3a1e1e';
      case 'warning':
        return '#3a2e1e';
      case 'info':
        return '#1e2a3a';
    }
  };

  const getBorderColor = () => {
    switch (type) {
      case 'success':
        return '#4ade80';
      case 'error':
        return '#f87171';
      case 'warning':
        return '#fbbf24';
      case 'info':
        return '#60a5fa';
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '12px',
        padding: '14px 16px',
        backgroundColor: getBackgroundColor(),
        border: `1px solid ${getBorderColor()}`,
        borderRadius: '6px',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)',
        minWidth: '300px',
        maxWidth: '450px',
        animation: 'slideIn 0.3s ease-out',
        marginBottom: '8px'
      }}
    >
      <div style={{ flexShrink: 0, paddingTop: '2px' }}>{getIcon()}</div>
      <div style={{ flex: 1, fontSize: '14px', color: '#d4d4d4', lineHeight: '1.5', whiteSpace: 'pre-wrap' }}>
        {message}
      </div>
      <button
        onClick={() => onClose(id)}
        style={{
          flexShrink: 0,
          backgroundColor: 'transparent',
          border: 'none',
          color: '#888',
          cursor: 'pointer',
          padding: '0',
          display: 'flex',
          transition: 'color 0.2s'
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = '#d4d4d4')}
        onMouseLeave={(e) => (e.currentTarget.style.color = '#888')}
      >
        <X size={18} />
      </button>
    </div>
  );
};

export default Toast;
