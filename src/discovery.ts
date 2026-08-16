/**
 * Controller discovery over UDP broadcast.
 *
 * Without this a user has to find their controller's IP address and pin it with
 * a DHCP reservation, because these devices advertise no mDNS. That is a real
 * barrier: most people do not know how to do either, and a moved lease silently
 * breaks the accessory with no clue why.
 *
 * The controller answers a broadcast of the literal `HF-A11ASSISTHREAD` on UDP
 * 48899 with a comma-separated line:
 *
 *     <ip>,<mac>,<model>
 *
 * Newer firmware appends a FOURTH field: 32 hex characters, stable across
 * queries, purpose unknown. We parse it so the format is understood, but we
 * never log or store it -- it has the shape of a device secret and nothing here
 * needs it.
 *
 * The MAC is the stable identity. Addresses move; the MAC does not, so
 * accessories are keyed on it and their address is refreshed by re-discovering.
 */
import * as dgram from 'dgram';

export const DISCOVERY_PORT = 48899;
export const DISCOVERY_MESSAGE = 'HF-A11ASSISTHREAD';

/** Long enough for a slow 2.4 GHz device to answer, short enough not to stall
 *  Homebridge's startup noticeably. */
export const DEFAULT_DISCOVERY_MS = 4000;

export interface DiscoveredDevice {
  ip: string;
  /** Normalised upper-case, no separators. The stable identity. */
  mac: string;
  model: string;
}

/** Parse one discovery reply. Returns null if it is not one. */
export function parseDiscoveryReply(text: string): DiscoveredDevice | null {
  const parts = text.trim().split(',');
  if (parts.length < 3) {
    return null;
  }
  const [ip, mac, model] = parts;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || !mac || !model) {
    return null;
  }
  // Deliberately ignoring parts[3] (the 32-hex token) -- see the file comment.
  return { ip, mac: mac.replace(/[^0-9a-fA-F]/g, '').toUpperCase(), model };
}

/**
 * Broadcast for controllers and collect replies until the timeout elapses.
 *
 * Never rejects on a network error -- a home network that blocks broadcast
 * should degrade to "found nothing", not crash the plugin at startup.
 */
export function discover(
  timeoutMs = DEFAULT_DISCOVERY_MS,
  broadcastAddress = '255.255.255.255',
): Promise<DiscoveredDevice[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredDevice>();
    let socket: dgram.Socket;

    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch {
      resolve([]);
      return;
    }

    const finish = (): void => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve([...found.values()]);
    };

    const timer = setTimeout(finish, timeoutMs);

    socket.on('error', finish);

    socket.on('message', (msg) => {
      const device = parseDiscoveryReply(msg.toString('utf8'));
      if (device && !found.has(device.mac)) {
        found.set(device.mac, device);
      }
    });

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
        socket.send(
          Buffer.from(DISCOVERY_MESSAGE, 'ascii'),
          DISCOVERY_PORT,
          broadcastAddress,
        );
      } catch {
        finish();
      }
    });
  });
}

/** Find one controller by MAC, to refresh an address that has moved. */
export async function findByMac(
  mac: string,
  timeoutMs = DEFAULT_DISCOVERY_MS,
): Promise<DiscoveredDevice | null> {
  const wanted = mac.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  const all = await discover(timeoutMs);
  return all.find((d) => d.mac === wanted) ?? null;
}
