import { useEffect, useState } from 'react'

type Health = { ok: boolean; uptimeSeconds: number }

export function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/health', { signal: controller.signal })
      .then((r) =>
        r.ok ? (r.json() as Promise<Health>) : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then(setHealth)
      .catch((e: unknown) => {
        if (controller.signal.aborted) return
        setError(e instanceof Error ? e.message : String(e))
      })
    return () => controller.abort()
  }, [])

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-3 p-8">
      <h1 className="text-2xl font-semibold tracking-tight">neohomepage</h1>
      <p className="opacity-70">
        Skeleton (F0). The board, the FAB and the widget catalog land in later phases.
      </p>
      <p className="font-mono text-sm">
        {error !== null
          ? `server unreachable: ${error}`
          : health === null
            ? 'checking server…'
            : `server ok — up ${health.uptimeSeconds}s`}
      </p>
    </main>
  )
}
