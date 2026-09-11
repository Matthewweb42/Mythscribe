import { IpcRequestError } from './ipc'

/** The message to show the author for a failed IPC call or any other thrown value. */
export function describeError(err: unknown): string {
  if (err instanceof IpcRequestError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong'
}
