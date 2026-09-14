/**
 * door-webhook — public edge receiver for CiviCRM webhooks.
 *
 * `fetch` validates an HMAC-signed request from the CiviRules custom action,
 * normalizes it to a WebhookEvent, and buffers it on a Cloudflare Queue, then
 * returns 202 immediately. The `queue` consumer pushes each event to the Pi's
 * door-sync receiver (over a Cloudflare Tunnel), re-signing with a distinct
 * secret and presenting a Cloudflare Access service token. Failed deliveries
 * are retried and, after max_retries, land in the dead-letter queue — so a Pi
 * reboot never loses an event.
 *
 * Never log member PII (names, emails, card IDs) — contact_id only.
 */

const TS_HEADER = 'X-Door-Sync-Timestamp';
const SIG_HEADER = 'X-Door-Sync-Signature';
const SIG_PREFIX = 'sha256=';
const MAX_SKEW_SECONDS = 300;
const PI_PATH = '/civicrm/membership-changed';
// Cap one delivery attempt: a stalled tunnel must not hold the invocation open
// until the runtime kills it. A timeout throws, so the message just retries.
const DELIVERY_TIMEOUT_MS = 10_000;

const enc = new TextEncoder();

/** A normalized membership-change event buffered on the queue. */
export interface WebhookEvent {
	contactId: number | null;
	deliveryId: string;
	/** Unix seconds: the producer's `occurred_at`, else when this Worker received it. */
	occurredAt: number;
}

function bytesToHex(bytes: Uint8Array): string {
	let out = '';
	for (const b of bytes) {
		out += b.toString(16).padStart(2, '0');
	}
	return out;
}

function hexToBytes(hex: string): Uint8Array | null {
	if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
		return null;
	}
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

function signedMessage(ts: number, body: Uint8Array): Uint8Array {
	const prefix = enc.encode(`${ts}.`);
	const out = new Uint8Array(prefix.length + body.length);
	out.set(prefix, 0);
	out.set(body, prefix.length);
	return out;
}

async function importKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

/**
 * Verify an HMAC-SHA256 signature over `${timestamp}.` + rawBody, with a
 * timestamp-skew (replay) check. Constant-time via crypto.subtle.verify;
 * fail-closed on any missing or malformed input. `signature` may be bare hex
 * or `sha256=<hex>`.
 */
export async function verifySignature(
	secret: string,
	rawBody: Uint8Array,
	timestamp: string | null,
	signature: string | null,
	maxSkewSeconds: number,
	nowSeconds: number,
): Promise<boolean> {
	if (!secret || !signature || !timestamp) {
		return false;
	}
	const ts = Number(timestamp);
	if (!Number.isInteger(ts)) {
		return false;
	}
	if (Math.abs(nowSeconds - ts) > maxSkewSeconds) {
		return false;
	}
	const providedHex = signature.startsWith(SIG_PREFIX) ? signature.slice(SIG_PREFIX.length) : signature;
	const providedBytes = hexToBytes(providedHex);
	if (!providedBytes) {
		return false;
	}
	const key = await importKey(secret, 'verify');
	return crypto.subtle.verify('HMAC', key, providedBytes, signedMessage(ts, rawBody));
}

/** Sign `${ts}.` + body with HMAC-SHA256, returning lowercase hex (no prefix). */
export async function signBody(secret: string, ts: number, body: string): Promise<string> {
	const key = await importKey(secret, 'sign');
	const sig = await crypto.subtle.sign('HMAC', key, signedMessage(ts, enc.encode(body)));
	return bytesToHex(new Uint8Array(sig));
}

/** A JSON integer, or an all-digits string — CiviCRM sometimes sends ids as strings. */
function asInteger(value: unknown): number | null {
	if (typeof value === 'number' && Number.isInteger(value)) {
		return value;
	}
	if (typeof value === 'string' && /^\d+$/.test(value)) {
		return Number(value);
	}
	return null;
}

/** Best-effort parse of the producer's payload. One pass over the raw body. */
function parsePayload(rawBody: Uint8Array): { contactId: number | null; occurredAt: number | null } {
	try {
		const payload: unknown = JSON.parse(new TextDecoder().decode(rawBody));
		if (payload && typeof payload === 'object') {
			const record = payload as Record<string, unknown>;
			return { contactId: asInteger(record.contact_id), occurredAt: asInteger(record.occurred_at) };
		}
	} catch {
		// Non-JSON or malformed: fall through. A missing id never blocks the
		// trigger — the Pi always runs a whole-population reconcile.
	}
	return { contactId: null, occurredAt: null };
}

async function deliverToPi(event: WebhookEvent, env: Env): Promise<void> {
	const ts = Math.floor(Date.now() / 1000);
	const body = JSON.stringify({
		contact_id: event.contactId,
		delivery_id: event.deliveryId,
		occurred_at: event.occurredAt,
	});
	const signature = await signBody(env.ORIGIN_HMAC_SECRET, ts, body);
	const url = new URL(PI_PATH, env.ORIGIN_URL).toString();
	const resp = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			[TS_HEADER]: String(ts),
			[SIG_HEADER]: SIG_PREFIX + signature,
			'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
			'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET,
		},
		body,
		signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
	});
	if (!resp.ok) {
		// Thrown -> the message is retried, then dead-lettered after max_retries.
		throw new Error(`origin returned ${resp.status}`);
	}
}

export default {
	async fetch(request, env, _ctx): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== 'POST' || url.pathname !== PI_PATH) {
			return new Response('not found', { status: 404 });
		}
		const raw = new Uint8Array(await request.arrayBuffer());
		const ok = await verifySignature(
			env.CIVICRM_WEBHOOK_SECRET,
			raw,
			request.headers.get(TS_HEADER),
			request.headers.get(SIG_HEADER),
			MAX_SKEW_SECONDS,
			Math.floor(Date.now() / 1000),
		);
		if (!ok) {
			return new Response('unauthorized', { status: 401 });
		}
		const payload = parsePayload(raw);
		const event: WebhookEvent = {
			contactId: payload.contactId,
			deliveryId: crypto.randomUUID(),
			// When CiviCRM fired, not when we received it: a queue retry can delay
			// delivery by minutes and the Pi should still see the original time.
			// Falls back to receive time if the producer omitted occurred_at.
			occurredAt: payload.occurredAt ?? Math.floor(Date.now() / 1000),
		};
		await env.EVENTS.send(event);
		console.log(`membership webhook accepted; contact_id=${event.contactId}; queued ${event.deliveryId}`);
		return new Response(null, { status: 202 });
	},

	async queue(batch, env, _ctx): Promise<void> {
		// Deliveries run concurrently: every event makes the Pi reconcile the whole
		// population, so order does not matter, and one slow origin request must not
		// delay the other messages in the batch. Each message acks or retries alone.
		await Promise.all(
			batch.messages.map(async (message) => {
				try {
					await deliverToPi(message.body as WebhookEvent, env);
					message.ack();
				} catch (err) {
					console.log(`delivery failed (attempt ${message.attempts}); will retry: ${String(err)}`);
					message.retry();
				}
			}),
		);
	},
} satisfies ExportedHandler<Env, WebhookEvent>;
