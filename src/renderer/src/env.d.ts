/// <reference types="vite/client" />
import type { DuoApi } from '../../preload/index'

declare global {
  interface Window {
    duo: DuoApi
  }
}

export {}
