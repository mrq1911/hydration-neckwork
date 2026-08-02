// Public URL of the sibling Explorer app, resolved at runtime rather than inlined
// by Vite, so one image can serve any deployment. `/config.js` is rewritten from
// the container's EXPLORER_URL on startup; see docker-entrypoint.d/.
//
// The build-time value is still honored as a fallback, so an image built with
// --build-arg VITE_EXPLORER_URL and no runtime env keeps working.

declare global {
  interface Window {
    __NECKWORK_CONFIG__?: { explorerUrl?: string }
  }
}

const DEFAULT_EXPLORER_URL = 'http://localhost:5174'

function firstConfigured(...candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim()
    // A container that never had EXPLORER_URL set leaves the placeholder in place.
    if (trimmed && !trimmed.startsWith('__')) return trimmed
  }
  return undefined
}

export const EXPLORER_URL =
  firstConfigured(
    globalThis.window?.__NECKWORK_CONFIG__?.explorerUrl,
    import.meta.env.VITE_EXPLORER_URL as string | undefined,
  ) ?? DEFAULT_EXPLORER_URL
