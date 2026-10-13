/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The Vireo cloud the app signs in with; empty when the cloud serves the app itself. */
  readonly VITE_VIREO_CLOUD?: string;
  /** Set when the app's host serves the cloud's paths on the app's own origin (apps/web/worker). */
  readonly VITE_VIREO_SAME_ORIGIN?: string;
}
