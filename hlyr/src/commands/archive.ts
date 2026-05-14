import { connectWithRetry } from '../daemonClient.js'
import { resolveFullConfig } from '../config.js'
import { homedir } from 'os'
import { join } from 'path'

interface ArchiveOptions {
  sessionId?: string
  daemonSocket?: string
  configFile?: string
}

export const archiveCommand = async (options: ArchiveOptions = {}) => {
  const sessionId = options.sessionId || process.env.HUMANLAYER_SESSION_ID

  if (!sessionId) {
    console.error(
      'No session ID provided. Use --session-id <id> or set HUMANLAYER_SESSION_ID environment variable.',
    )
    process.exit(1)
  }

  try {
    const config = resolveFullConfig(options)
    let socketPath = config.daemon_socket

    if (socketPath.startsWith('~')) {
      socketPath = join(homedir(), socketPath.slice(1))
    }

    const client = await connectWithRetry(socketPath, 3, 1000)

    try {
      await client.archiveSession(sessionId)
      console.log(`Session ${sessionId} archived.`)
    } finally {
      client.close()
    }
  } catch (error) {
    console.error('Failed to archive session:', error)
    process.exit(1)
  }
}
