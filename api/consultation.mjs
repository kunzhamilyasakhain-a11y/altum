const recipient = 'contact@altum.kz';
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const reply = (status, body) => Response.json(body, {
  status, headers: {'Cache-Control': 'no-store'},
});

async function sendMail(message, env) {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_APP_PASSWORD) {
    throw Object.assign(new Error('SMTP not configured'), {code:'SMTP_CONFIG'});
  }
  const {default: nodemailer} = await import('nodemailer');
  const smtp = nodemailer.createTransport({
    host: env.SMTP_HOST, port: 465, secure: true,
    auth: {user: env.SMTP_USER, pass: env.SMTP_APP_PASSWORD},
    connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 10000,
  });
  const result = await smtp.sendMail({from: env.SMTP_USER, ...message});
  if (!result.accepted.some(address => address.toLowerCase() === recipient)) {
    throw new Error('Recipient not accepted');
  }
}

export function createHandler(send = sendMail, env = process.env) {
  const allowed = new Set(['https://www.ispringsolutions.kz']);
  if (env.VERCEL_URL) allowed.add('https://' + env.VERCEL_URL);
  return async function handle(request) {
    if (request.method !== 'POST') return reply(405, {ok:false});
    if (!allowed.has(request.headers.get('origin'))) return reply(403, {ok:false});
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
    if (!valid) return reply(400, {ok:false});
    try {
      await send({
        to: recipient,
        subject: 'Новая заявка с сайта iSpring Solutions',
        text: 'Имя: ' + name.trim() + '\n' + (method === 'email' ? 'Email: ' : 'Телефон: ') + value,
        ...(method === 'email' ? {replyTo:value} : {}),
      }, env);
      return reply(200, {ok:true});
    } catch (error) {
      console.warn('Consultation SMTP failure', {code: /^[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'UNKNOWN', responseCode: Number.isInteger(error?.responseCode) ? error.responseCode : null});
      return reply(503, {ok:false});
    }
  };
}

export default {fetch: createHandler()};
