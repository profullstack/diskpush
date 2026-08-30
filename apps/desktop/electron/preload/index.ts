import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type IpcResult } from '../shared/contract.js'

/**
 * The entire surface the renderer can see.
 *
 * Named operations only. No `invoke(channel, args)` escape hatch, because that
 * would make the allowlist advisory rather than actual.
 */
function call<T>(channel: string, payload?: unknown): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channel, payload)
}

const api = {
  connections: {
    list: () => call(IPC.connectionsList),
    save: (input: unknown) => call(IPC.connectionsSave, input),
    remove: (id: string) => call(IPC.connectionsRemove, { id }),
    test: (id: string) => call(IPC.connectionsTest, { id }),
    importSshConfig: (path?: string) => call(IPC.connectionsImport, path ? { path } : {}),
    sshConfigHosts: () => call(IPC.connectionsSshConfig),
  },
  fs: {
    homeLocal: () => call<string>(IPC.fsHomeLocal),
    listLocal: (path: string) => call(IPC.fsListLocal, { path }),
    listRemote: (connectionId: string, path: string) => call(IPC.fsListRemote, { connectionId, path }),
    // Mutations name an entry inside a directory; the main process joins them.
    mkdir: (directory: string, name: string, connectionId?: string) =>
      call<boolean>(connectionId ? IPC.fsMkdirRemote : IPC.fsMkdirLocal, { connectionId, directory, name }),
    createFile: (directory: string, name: string, connectionId?: string) =>
      call<boolean>(connectionId ? IPC.fsCreateFileRemote : IPC.fsCreateFileLocal, { connectionId, directory, name }),
    rename: (directory: string, from: string, to: string, connectionId?: string) =>
      call<boolean>(connectionId ? IPC.fsRenameRemote : IPC.fsRenameLocal, { connectionId, directory, from, to }),
    remove: (directory: string, name: string, isDirectory: boolean, connectionId?: string) =>
      call<boolean>(connectionId ? IPC.fsDeleteRemote : IPC.fsDeleteLocal, {
        connectionId,
        directory,
        name,
        isDirectory,
      }),
  },
  transfers: {
    preview: (request: unknown) => call(IPC.transfersPreview, request),
    start: (request: unknown) => call(IPC.transfersStart, request),
    cancel: (jobId: string) => call(IPC.transfersCancel, { jobId }),
    list: (limit = 50) => call(IPC.transfersList, { limit }),
  },
  profiles: {
    list: () => call(IPC.profilesList),
    remove: (id: string) => call(IPC.profilesRemove, { id }),
  },
  shell: {
    openExternal: (url: string) => call(IPC.shellOpenExternal, { url }),
  },
  events: {
    /**
     * Returns an unsubscribe function. The listener is wrapped so the
     * renderer never receives Electron's IpcRendererEvent, which carries a
     * `sender` that would widen this surface considerably.
     */
    onTransfer(listener: (payload: { jobId: string; event: unknown }) => void): () => void {
      const wrapped = (_event: unknown, payload: { jobId: string; event: unknown }) => listener(payload)
      ipcRenderer.on(IPC.eventTransfer, wrapped)
      return () => ipcRenderer.off(IPC.eventTransfer, wrapped)
    },
  },
}

contextBridge.exposeInMainWorld('diskpush', api)

export type DiskPushApi = typeof api
