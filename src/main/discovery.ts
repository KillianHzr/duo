import { createSocket } from 'node:dgram'
import { networkInterfaces } from 'node:os'
import { DUO_PORT, DISCOVERY_REQUEST, type DiscoveryReply } from '../shared/protocol'

/** Broadcast address of every IPv4 interface (e.g. 192.168.1.255). */
function broadcastAddresses(): string[] {
  const result = new Set<string>(['127.0.0.1', '255.255.255.255'])
  for (const list of Object.values(networkInterfaces())) {
    for (const itf of list ?? []) {
      if (itf.family !== 'IPv4' || itf.internal) continue
      const ip = itf.address.split('.').map(Number)
      const mask = itf.netmask.split('.').map(Number)
      result.add(ip.map((octet, i) => (octet | (~mask[i] & 255)) & 255).join('.'))
    }
  }
  return [...result]
}

/**
 * Looks for Duo servers on the local network with a UDP broadcast.
 * Returns their WebSocket URLs, this machine first.
 */
export function discoverServers(timeoutMs = 700): Promise<string[]> {
  return new Promise((resolve) => {
    const found = new Set<string>()
    const socket = createSocket('udp4')
    let done = false

    const finish = (): void => {
      if (done) return
      done = true
      try {
        socket.close()
      } catch {
        /* already closed */
      }
      const urls = [...found]
      urls.sort((a, b) => Number(b.includes('127.0.0.1')) - Number(a.includes('127.0.0.1')))
      resolve(urls)
    }

    socket.on('error', finish)
    socket.on('message', (data, rinfo) => {
      try {
        const reply = JSON.parse(data.toString()) as DiscoveryReply
        if (reply.service === 'duo' && Number.isInteger(reply.port)) {
          found.add(`ws://${rinfo.address}:${reply.port}`)
        }
      } catch {
        /* unrelated packet */
      }
    })

    socket.bind(0, () => {
      socket.setBroadcast(true)
      for (const address of broadcastAddresses()) {
        socket.send(DISCOVERY_REQUEST, DUO_PORT, address, () => {
          /* one unreachable interface must not stop the others */
        })
      }
      setTimeout(finish, timeoutMs)
    })
  })
}
