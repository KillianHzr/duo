/**
 * Standalone Peinard server, for hosting without the desktop app (e.g. on a home server).
 * Usage: npm run server            — reuses or creates an access code in ~/.peinard/code
 *        PEINARD_CODE=ABC234 npm run server
 *        PEINARD_DATA=/path/to/folder npm run server   — where chat, notes and media are kept (default ~/.peinard/data)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { generateCode, startDuoServer } from '../src/server/duo-server'
import { DUO_PORT, normalizeCode } from '../src/shared/protocol'

function loadCode(): string {
  if (process.env.PEINARD_CODE) return normalizeCode(process.env.PEINARD_CODE)
  const dir = join(homedir(), '.peinard')
  const file = join(dir, 'code')
  if (existsSync(file)) return normalizeCode(readFileSync(file, 'utf8'))
  const code = generateCode()
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, code)
  return code
}

const code = loadCode()
const stamp = (): string => new Date().toISOString().slice(11, 19)

startDuoServer({
  code,
  // Chat messages, notes and media are kept here.
  dataDir: process.env.PEINARD_DATA ?? join(homedir(), '.peinard', 'data'),
  port: Number(process.env.DUO_PORT ?? DUO_PORT),
  log: (message) => console.log(stamp(), message)
})
  .then((server) => {
    console.log(stamp(), `Access code: ${code}`)
    const shutdown = (): void => void server.close().then(() => process.exit(0))
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  })
  .catch((err: NodeJS.ErrnoException) => {
    console.error(
      err.code === 'EADDRINUSE' ? 'Port already in use: is another Peinard server running?' : err.message
    )
    process.exit(1)
  })
