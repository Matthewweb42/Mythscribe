import type { IpcBridge } from '../shared/ipc/contract'

declare global {
  interface Window {
    mythscribe: IpcBridge
  }
}

export {}
