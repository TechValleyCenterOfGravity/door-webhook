import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { signBody, verifySignature } from '../src/index';

// Correctly-typed Request for worker.fetch() (matches the pool-workers scaffold).
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const enc = new TextEncoder();
const SECRET = 'unit-civicrm-secret-0123456789';
const ORIGIN_SECRET = 'unit-origin-secret-0123456789';
const PATH = '/civicrm/membership-changed';

async function hmacHex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function signedRequest(
	body: string,
	opts: { secret?: string; ts?: number } = {},
): Promise<Request<unknown, IncomingRequestCfProperties>> {
	const secret = opts.secret ?? SECRET;
	const ts = opts.ts ?? Math.floor(Date.now() / 1000);
	const hex = await hmacHex(secret, `${ts}.${body}`);
	return new IncomingRequest('https://webhook.example.com' + PATH, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Door-Sync-Timestamp': String(ts),
			'X-Door-Sync-Signature': 'sha256=' + hex,
		},
		body,
	});
}

function fetchEnv(overrides: Record<string, unknown> = {}) {
	const sent: unknown[] = [];
	const env = {
		CIVICRM_WEBHOOK_SECRET: SECRET,
		EVENTS: { send: vi.fn(async (b: unknown) => void sent.push(b)) },
		...overrides,
	} as unknown as Env;
	return { env, sent };
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('verifySignature', () => {
	it('accepts a correct signature', async () => {
		const body = enc.encode('{"contact_id": 5}');
		const ts = 1_000_000;
		const hex = await hmacHex(SECRET, `${ts}.` + '{"contact_id": 5}');
		expect(await verifySignature(SECRET, body, String(ts), 'sha256=' + hex, 300, ts)).toBe(true);
	});

	it('accepts a bare (unprefixed) hex signature', async () => {
		const body = enc.encode('{}');
		const ts = 1_000_000;
		const hex = await hmacHex(SECRET, `${ts}.{}`);
		expect(await verifySignature(SECRET, body, String(ts), hex, 300, ts)).toBe(true);
	});

	it('rejects a tampered body', async () => {
		const ts = 1_000_000;
		const hex = await hmacHex(SECRET, `${ts}.original`);
		expect(await verifySignature(SECRET, enc.encode('tampered'), String(ts), 'sha256=' + hex, 300, ts)).toBe(false);
	});

	it('rejects a wrong secret', async () => {
		const body = enc.encode('{}');
		const ts = 1_000_000;
		const hex = await hmacHex('other-secret', `${ts}.{}`);
		expect(await verifySignature(SECRET, body, String(ts), 'sha256=' + hex, 300, ts)).toBe(false);
	});

	it('rejects missing timestamp or signature', async () => {
		const body = enc.encode('{}');
		expect(await verifySignature(SECRET, body, null, 'sha256=abc', 300, 1_000_000)).toBe(false);
		expect(await verifySignature(SECRET, body, '1000000', null, 300, 1_000_000)).toBe(false);
	});

	it('rejects a stale timestamp (replay)', async () => {
		const body = enc.encode('{}');
		const ts = 1_000_000;
		const hex = await hmacHex(SECRET, `${ts}.{}`);
		expect(await verifySignature(SECRET, body, String(ts), 'sha256=' + hex, 300, ts + 10_000)).toBe(false);
	});

	it('rejects a non-integer or bad-hex signature', async () => {
		const body = enc.encode('{}');
		expect(await verifySignature(SECRET, body, 'not-a-number', 'sha256=deadbeef', 300, 1_000_000)).toBe(false);
		expect(await verifySignature(SECRET, body, '1000000', 'sha256=zz', 300, 1_000_000)).toBe(false);
	});
});

describe('signBody round-trips with verifySignature', () => {
	it('produces a signature verifySignature accepts', async () => {
		const body = '{"contact_id": 9}';
		const ts = 1_234_567;
		const hex = await signBody(ORIGIN_SECRET, ts, body);
		expect(await verifySignature(ORIGIN_SECRET, enc.encode(body), String(ts), 'sha256=' + hex, 300, ts)).toBe(true);
	});
});

describe('fetch (receiver)', () => {
	it('accepts a signed request, enqueues an event, returns 202', async () => {
		const { env, sent } = fetchEnv();
		const req = await signedRequest('{"contact_id": 7}');
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(202);
		expect(sent).toHaveLength(1);
		expect((sent[0] as { contactId: number }).contactId).toBe(7);
		expect(typeof (sent[0] as { deliveryId: string }).deliveryId).toBe('string');
	});

	it('rejects a bad signature with 401 and does not enqueue', async () => {
		const { env, sent } = fetchEnv();
		const req = await signedRequest('{"contact_id": 7}');
		req.headers.set('X-Door-Sync-Signature', 'sha256=bad');
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(401);
		expect(sent).toHaveLength(0);
	});

	it('rejects a missing signature with 401', async () => {
		const { env, sent } = fetchEnv();
		const req = new IncomingRequest('https://webhook.example.com' + PATH, { method: 'POST', body: '{}' });
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(401);
		expect(sent).toHaveLength(0);
	});

	it('enqueues with contactId null when the payload has no contact_id', async () => {
		const { env, sent } = fetchEnv();
		const req = await signedRequest('{"something_else": true}');
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(202);
		expect((sent[0] as { contactId: number | null }).contactId).toBeNull();
	});

	it('carries the producer occurred_at through to the queue', async () => {
		const { env, sent } = fetchEnv();
		const ctx = createExecutionContext();
		const res = await worker.fetch(await signedRequest('{"contact_id":7,"occurred_at":1789000000}'), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(res.status).toBe(202);
		// The CiviCRM event time, not the receive time — a queue retry must not
		// shift what the Pi sees.
		expect((sent[0] as { occurredAt: number }).occurredAt).toBe(1789000000);
	});

	it('falls back to receive time when the producer omits occurred_at', async () => {
		const { env, sent } = fetchEnv();
		const before = Math.floor(Date.now() / 1000);
		const ctx = createExecutionContext();
		const res = await worker.fetch(await signedRequest('{"contact_id":7}'), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(res.status).toBe(202);
		const { occurredAt } = sent[0] as { occurredAt: number };
		expect(occurredAt).toBeGreaterThanOrEqual(before);
		expect(occurredAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
	});

	it('returns 404 for the wrong method or path', async () => {
		const { env } = fetchEnv();
		const ctx = createExecutionContext();
		const getRes = await worker.fetch(new IncomingRequest('https://webhook.example.com' + PATH), env, ctx);
		expect(getRes.status).toBe(404);
		const wrongPath = await signedRequest('{}');
		const wrongPathReq = new IncomingRequest('https://webhook.example.com/nope', {
			method: 'POST',
			headers: wrongPath.headers,
			body: '{}',
		});
		const res = await worker.fetch(wrongPathReq, env, ctx);
		expect(res.status).toBe(404);
	});
});

describe('CiviCRM producer contract', () => {
	// Golden vector produced by real PHP (8.5.8), using the exact logic of
	// door-civirules' CRM_CivirulesActions_DoorSync_Base::processAction and
	// MembershipWebhook::buildPayload:
	//
	//   $body = json_encode(['contact_id' => 42, 'occurred_at' => 1789000000], JSON_UNESCAPED_SLASHES);
	//   $sig  = hash_hmac('sha256', $ts . '.' . $body, $secret);
	//
	// This is the cross-repo signing contract. If it breaks, CiviCRM's webhooks
	// start 401ing in production — regenerate it from door-civirules rather than
	// editing the expected values to match new Worker behaviour.
	const PHP_BODY = '{"contact_id":42,"occurred_at":1789000000}';
	const PHP_TIMESTAMP = '1789000000';
	const PHP_SIGNATURE = 'sha256=9db87308e8a5697097b17d481bfad994acacc71be62710b522114c1e9f0e36f7';

	it('accepts a signature produced by the PHP CiviRules action', async () => {
		const ok = await verifySignature(SECRET, enc.encode(PHP_BODY), PHP_TIMESTAMP, PHP_SIGNATURE, 300, Number(PHP_TIMESTAMP));
		expect(ok).toBe(true);
	});

	it('rejects the PHP vector under a different secret', async () => {
		const ok = await verifySignature('other-secret', enc.encode(PHP_BODY), PHP_TIMESTAMP, PHP_SIGNATURE, 300, Number(PHP_TIMESTAMP));
		expect(ok).toBe(false);
	});

	it('enqueues the contact_id from the PHP payload shape', async () => {
		const { env, sent } = fetchEnv();
		const hex = await hmacHex(SECRET, `${PHP_TIMESTAMP}.${PHP_BODY}`);
		const req = new IncomingRequest('https://webhook.example.com' + PATH, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Door-Sync-Timestamp': PHP_TIMESTAMP,
				'X-Door-Sync-Signature': 'sha256=' + hex,
			},
			body: PHP_BODY,
		});
		// The vector's timestamp is fixed, so hold "now" there to clear the replay window.
		vi.setSystemTime(Number(PHP_TIMESTAMP) * 1000);
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(res.status).toBe(202);
		expect((sent[0] as { contactId: number }).contactId).toBe(42);
	});
});

describe('queue (consumer)', () => {
	function queueEnv() {
		return {
			ORIGIN_URL: 'https://pi.example.org',
			ORIGIN_HMAC_SECRET: ORIGIN_SECRET,
			CF_ACCESS_CLIENT_ID: 'cid',
			CF_ACCESS_CLIENT_SECRET: 'csec',
		} as unknown as Env;
	}

	function fakeMessage(body: unknown) {
		return { id: 'm1', timestamp: new Date(0), body, attempts: 1, ack: vi.fn(), retry: vi.fn() };
	}

	it('delivers to the Pi with a valid signature + Access headers and acks on 2xx', async () => {
		const fetchMock = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(new Response(null, { status: 202 })));
		vi.stubGlobal('fetch', fetchMock);
		const msg = fakeMessage({ contactId: 7, deliveryId: 'd-1', occurredAt: 1_700_000_000 });
		const batch = { queue: 'door-webhook-events', messages: [msg], ackAll: vi.fn(), retryAll: vi.fn() };
		const ctx = createExecutionContext();
		await worker.queue(batch as never, queueEnv(), ctx);
		await waitOnExecutionContext(ctx);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe('https://pi.example.org/civicrm/membership-changed');
		expect(init.method).toBe('POST');
		const headers = init.headers as Record<string, string>;
		expect(headers['CF-Access-Client-Id']).toBe('cid');
		expect(headers['CF-Access-Client-Secret']).toBe('csec');
		const ts = headers['X-Door-Sync-Timestamp'];
		const bodyStr = init.body as string;
		expect(headers['X-Door-Sync-Signature']).toBe('sha256=' + (await hmacHex(ORIGIN_SECRET, `${ts}.${bodyStr}`)));
		expect(JSON.parse(bodyStr).contact_id).toBe(7);
		expect(msg.ack).toHaveBeenCalledTimes(1);
		expect(msg.retry).not.toHaveBeenCalled();
	});

	it('retries the message when the Pi returns a non-2xx', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(null, { status: 503 })),
		);
		const msg = fakeMessage({ contactId: 7, deliveryId: 'd-1', occurredAt: 1 });
		const batch = { queue: 'door-webhook-events', messages: [msg], ackAll: vi.fn(), retryAll: vi.fn() };
		const ctx = createExecutionContext();
		await worker.queue(batch as never, queueEnv(), ctx);
		await waitOnExecutionContext(ctx);
		expect(msg.retry).toHaveBeenCalledTimes(1);
		expect(msg.ack).not.toHaveBeenCalled();
	});

	it('caps each delivery with an abort signal, and retries when one aborts', async () => {
		let seenSignal: AbortSignal | null | undefined;
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, init: RequestInit) => {
				seenSignal = init.signal;
				// What a stalled origin produces once AbortSignal.timeout() fires.
				return Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
			}),
		);
		const msg = fakeMessage({ contactId: 7, deliveryId: 'd-1', occurredAt: 1 });
		const batch = { queue: 'door-webhook-events', messages: [msg], ackAll: vi.fn(), retryAll: vi.fn() };
		const ctx = createExecutionContext();
		await worker.queue(batch as never, queueEnv(), ctx);
		await waitOnExecutionContext(ctx);

		expect(seenSignal).toBeInstanceOf(AbortSignal);
		expect(seenSignal?.aborted).toBe(false);
		expect(msg.retry).toHaveBeenCalledTimes(1);
		expect(msg.ack).not.toHaveBeenCalled();
	});

	it('delivers a batch concurrently, so one slow origin request does not block the rest', async () => {
		const started: string[] = [];
		let releaseSlow!: (resp: Response) => void;
		const slow = new Promise<Response>((resolve) => {
			releaseSlow = resolve;
		});
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, init: RequestInit) => {
				const id = JSON.parse(init.body as string).delivery_id as string;
				started.push(id);
				// 'd-slow' only settles once the *next* delivery has started, which can
				// happen only if the batch is not delivered one message at a time.
				if (id === 'd-slow') {
					return slow;
				}
				releaseSlow(new Response(null, { status: 202 }));
				return Promise.resolve(new Response(null, { status: 202 }));
			}),
		);
		const slowMsg = fakeMessage({ contactId: 1, deliveryId: 'd-slow', occurredAt: 1 });
		const fastMsg = fakeMessage({ contactId: 2, deliveryId: 'd-fast', occurredAt: 1 });
		const batch = { queue: 'door-webhook-events', messages: [slowMsg, fastMsg], ackAll: vi.fn(), retryAll: vi.fn() };
		const ctx = createExecutionContext();
		await worker.queue(batch as never, queueEnv(), ctx);
		await waitOnExecutionContext(ctx);

		expect(started).toEqual(['d-slow', 'd-fast']);
		expect(slowMsg.ack).toHaveBeenCalledTimes(1);
		expect(fastMsg.ack).toHaveBeenCalledTimes(1);
	});

	it('acks and retries messages in the same batch independently', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init: RequestInit) => {
				const id = JSON.parse(init.body as string).delivery_id as string;
				return new Response(null, { status: id === 'd-bad' ? 500 : 202 });
			}),
		);
		const goodMsg = fakeMessage({ contactId: 1, deliveryId: 'd-good', occurredAt: 1 });
		const badMsg = fakeMessage({ contactId: 2, deliveryId: 'd-bad', occurredAt: 1 });
		const batch = { queue: 'door-webhook-events', messages: [goodMsg, badMsg], ackAll: vi.fn(), retryAll: vi.fn() };
		const ctx = createExecutionContext();
		await worker.queue(batch as never, queueEnv(), ctx);
		await waitOnExecutionContext(ctx);

		expect(goodMsg.ack).toHaveBeenCalledTimes(1);
		expect(goodMsg.retry).not.toHaveBeenCalled();
		expect(badMsg.retry).toHaveBeenCalledTimes(1);
		expect(badMsg.ack).not.toHaveBeenCalled();
	});
});
