/// <reference types="vite/client" />

/**
 * Declared rather than left to vite/client's index signature, which types every
 * unknown key as `any`. `VITE_SOCKET_URL` is optional on purpose -- absence is a
 * supported state with defined behaviour, documented in lib/socket-origin.ts --
 * and `string | undefined` is what forces callers to handle it.
 */
interface ImportMetaEnv {
  readonly VITE_SOCKET_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
