import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { channels, eventNames, type IpcBridge } from '@shared/ipc/contract'

const allowedChannels = new Set<string>(channels)
const allowedEvents = new Set<string>(eventNames)

const bridge: IpcBridge = {
  invoke(channel, input) {
    if (!allowedChannels.has(channel)) {
      return Promise.resolve({
        ok: false,
        error: { code: 'VALIDATION', message: `Unknown IPC channel: ${String(channel)}` }
      })
    }
    return ipcRenderer.invoke(channel, input)
  },
  on(event, listener) {
    if (!allowedEvents.has(event)) return () => undefined
    const wrapped = (_e: IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on(event, wrapped)
    return () => ipcRenderer.removeListener(event, wrapped)
  }
}

contextBridge.exposeInMainWorld('mythscribe', bridge)
