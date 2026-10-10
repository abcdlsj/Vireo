/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The Vireo cloud the app signs in with; empty when the cloud serves the app itself. */
  readonly VITE_VIREO_CLOUD?: string;
}
