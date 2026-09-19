import { createHmac, timingSafeEqual } from 'node:crypto';

// Set LINQ_WEBHOOK_SECRET to turn on signature checking. Until it is set,
// requests are accepted unverified — fine for local poking, not for production.
const SECRET = process.env.LINQ_WEBHOOK_SECRET ?? '';

// TODO: confirm the header name and digest scheme against Linq's webhook docs
// before relying on this. The comparison itself is correct; the inputs are a guess.
const SIGNATURE_HEADER = 'x-linq-signature';

function isSignatureValid(raw: string, signature: string | null): boolean {
  if (!signature) return false;

  const expected = createHmac('sha256', SECRET).update(raw).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);

  // timingSafeEqual throws on a length mismatch, so check that first.
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<Response> {
  // Read the body as text, not JSON: a signature covers the exact bytes sent,
  // and re-serializing a parsed object will not reproduce them.
  const raw = await request.text();

  if (SECRET && !isSignatureValid(raw, request.headers.get(SIGNATURE_HEADER))) {
    console.warn('webhook: bad signature');
    return new Response('invalid signature', { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    console.warn('webhook: body was not JSON:', raw.slice(0, 200));
    return new Response('expected JSON', { status: 400 });
  }

  console.log('webhook:', JSON.stringify(payload, null, 2));

  // Game logic goes here. Keep it quick — webhook senders retry on a slow
  // reply, and a serverless function stops executing once this returns, so
  // anything kicked off without awaiting may never finish.

  return new Response(null, { status: 204 });
}
