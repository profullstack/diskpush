import { DiskPushStore } from '@diskpush/database'

/** One store for the app's lifetime, shared with the CLI on disk. */
let instance: Promise<DiskPushStore> | null = null

export function store(): Promise<DiskPushStore> {
  instance ??= DiskPushStore.open()
  return instance
}
