// Public URL of the sibling Preis app, resolved at runtime rather than inlined
// by Vite, so one image can serve any deployment. `/config.js` is rewritten from
// the container's PREIS_URL on startup; see docker-entrypoint.d/.
//
// The build-time value is still honored as a fallback, so an image built with
// --build-arg VITE_PREIS_URL and no runtime env keeps working.

declare global {
  interface Window {
    __NECKWORK_CONFIG__?: { preisUrl?: string }
  }
}

const DEFAULT_PREIS_URL = 'http://localhost:5173'

function firstConfigured(...candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim()
    // A container that never had PREIS_URL set leaves the placeholder in place.
    if (trimmed && !trimmed.startsWith('__')) return trimmed
  }
  return undefined
}

export const PREIS_URL =
  firstConfigured(
    globalThis.window?.__NECKWORK_CONFIG__?.preisUrl,
    import.meta.env.VITE_PREIS_URL as string | undefined,
  ) ?? DEFAULT_PREIS_URL
