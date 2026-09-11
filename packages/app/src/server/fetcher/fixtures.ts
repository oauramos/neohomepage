import { createServer, type Server } from 'node:http'
import { once } from 'node:events'

/** Loopback HTTP servers for the fetcher tests, torn down by `closeServers` in `afterEach`. */

const servers: Server[] = []

export async function serve(handler: Parameters<typeof createServer>[1]): Promise<URL> {
  const server = createServer(handler)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  return new URL(`http://127.0.0.1:${address.port}/`)
}

/** Close the most recently started server, so a test can dial a port nothing listens on. */
export async function closeLatest(): Promise<void> {
  const server = servers.pop()
  if (server === undefined) return
  await new Promise((resolve) => server.close(resolve))
}

export async function closeServers(): Promise<void> {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}
