// src/renderer/src/hooks/useMenuEvents.ts
import { useEffect } from 'react';

export function useMenuEvents(handlers: Record<string, () => void>) {
  useEffect(() => {
    const handleMenuEvent = (event: string) => {
      const handler = handlers[event];
      if (handler) {
        handler();
      } else {
        console.log(`Menu event not handled: ${event}`);
      }
    };

    window.api.onMenuEvent(handleMenuEvent);
  }, [handlers]);
}
