// ──────────────────────────────────────────────────────────────────────────
// ChirpStack LoRaWAN downlink — the "act locally" edge of the agent. After a
// human approves an irrigation proposal, we enqueue a downlink to the pump
// node, reusing NaLog's ChirpStack contract:
//   POST {CHIRPSTACK_API_URL}/api/devices/{devEUI}/queue
//
// NOTE: the NaLog process Lambda had a bug where every command encoded 0x00
// (OFF) because it compared action against 'on' but was called with 'start'.
// Here we map explicitly: on → 0x01 ("AQ=="), off → 0x00 ("AA==").
// ──────────────────────────────────────────────────────────────────────────
import config from '../config.js';
import logger from '../logger.js';

const PUMP_FPORT = 1;

export function encodePumpCommand(action) {
  const on = action === 'on' || action === 'start';
  return Buffer.from([on ? 0x01 : 0x00]).toString('base64'); // "AQ==" / "AA=="
}

/**
 * Enqueue a pump downlink. Returns { sent, simulated, payload }.
 * If ChirpStack isn't configured, we log and return simulated:true so the demo
 * and HITL flow still work end-to-end without hardware.
 */
export async function sendPumpCommand(devEUI, action) {
  const payload = encodePumpCommand(action);
  if (!devEUI) throw new Error('sendPumpCommand requires a devEUI');

  if (!config.chirpstack.apiUrl || !config.chirpstack.apiToken) {
    logger.warn({ devEUI, action, payload }, 'ChirpStack not configured — downlink simulated');
    return { sent: false, simulated: true, payload, fPort: PUMP_FPORT };
  }

  const url = `${config.chirpstack.apiUrl}/api/devices/${devEUI}/queue`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.chirpstack.apiToken}`,
    },
    body: JSON.stringify({
      deviceQueueItem: { confirmed: true, data: payload, fPort: PUMP_FPORT },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ChirpStack downlink failed: ${res.status} ${body}`);
  }
  logger.info({ devEUI, action, payload }, 'ChirpStack downlink enqueued');
  return { sent: true, simulated: false, payload, fPort: PUMP_FPORT };
}
