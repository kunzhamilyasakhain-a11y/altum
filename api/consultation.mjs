const recipient = 'contact@altum.kz';
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

async function sendMail({replyTo, ...message}, env) {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_NOT_CONFIGURED');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'iSpring Solutions <forms@notify.ispringsolutions.kz>',
      ...message,
      to: [message.to],
      ...(replyTo ? {reply_to: replyTo} : {}),
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('RESEND_HTTP_' + response.status);
  const result = await response.json();
  if (typeof result.id !== 'string' || !result.id) throw new Error('RESEND_NO_MESSAGE_ID');
}

export function createHandler(send = sendMail, env = process.env) {
  const corporate = new Set([
    'https://altum.kz',
    'https://www.altum.kz',
    'https://altum-consulting.vercel.app',
  ]);
  const allowed = new Set(['https://www.ispringsolutions.kz', 'https://altum-eta.vercel.app', ...corporate]);
  if (env.VERCEL_URL) allowed.add('https://' + env.VERCEL_URL);
  return async function handle(request) {
    const origin = request.headers.get('origin');
    const headers = new Headers({'Cache-Control': 'no-store', Vary: 'Origin'});
    const reply = (status, body) => Response.json(body, {status, headers});
    if (!allowed.has(origin)) return reply(403, {ok:false});
    headers.set('Access-Control-Allow-Origin', origin);
    if (request.method === 'OPTIONS') {
      headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Content-Type');
      return new Response(null, {status: 204, headers});
    }
    if (request.method !== 'POST') return reply(405, {ok:false});
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return reply(415, {ok:false});
    let data;
    try {
      const reader = request.body?.getReader();
      if (!reader) return reply(400, {ok:false});
      const decoder = new TextDecoder();
      let size = 0;
      let raw = '';
      for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) {
          await reader.cancel();
          return reply(413, {ok:false});
        }
        raw += decoder.decode(value, {stream:true});
      }
      data = JSON.parse(raw + decoder.decode());
    } catch {
      return reply(400, {ok:false});
    }
    const {name, method, contact} = data ?? {};
    if (typeof name !== 'string' || !name.trim() || name.length > 100 || /[\r\n]/.test(name)
      || typeof contact !== 'string' || contact.length > 150 || /[\r\n]/.test(contact)) {
      return reply(400, {ok:false});
    }
    const value = contact.trim();
    const valid = method === 'email' ? email.test(value)
      : method === 'phone' && /^[+0-9 ()-]+$/.test(value) && /^\d{10,15}$/.test(value.replace(/\D/g, ''));
    if (!valid || (corporate.has(origin) && method !== 'email')) return reply(400, {ok:false});
    try {
      await send({
        to: recipient,
        subject: corporate.has(origin)
          ? 'Новая заявка с сайта ALTUM Consulting'
          : 'Новая заявка с сайта iSpring Solutions',
        text: 'Имя: ' + name.trim() + '\n' + (method === 'email' ? 'Email: ' : 'Телефон: ') + value,
        ...(method === 'email' ? {replyTo:value} : {}),
      }, env);
      return reply(200, {ok:true});
    } catch (error) {
      const reason = /^(RESEND_NOT_CONFIGURED|RESEND_NO_MESSAGE_ID|RESEND_HTTP_\d{3})$/.test(error?.message)
        ? error.message : 'RESEND_REQUEST_FAILED';
      console.warn('Consultation email failure', {reason});
      return reply(503, {ok:false});
    }
  };
}

export default {fetch: createHandler()};
