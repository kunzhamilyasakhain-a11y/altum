const titles = {
  courses: "Разработка электронных курсов",
  training: "Корпоративное обучение и бизнес-игры",
  digital: "Digital Marketing & AI",
};
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phonePattern = /^\+?[\d() .-]{7,30}$/;

/** The only success path is an acknowledged email-provider delivery receipt. */
export async function handleContact(
  request,
  env = process.env,
  transport = fetch,
) {
  const origin = request.headers.get("origin");
  const origins = (env.CONTACT_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const cors =
    origin && origins.includes(origin)
      ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
      : {};
  const reply = (status, data) =>
    Response.json(data, {
      status,
      headers: { ...cors, "Cache-Control": "no-store" },
    });
  if (!origin || !origins.includes(origin))
    return reply(403, { error: "origin_not_allowed" });
  if (request.method === "OPTIONS")
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  if (request.method !== "POST")
    return reply(405, { error: "method_not_allowed" });
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return reply(415, { error: "json_required" });
  if (Number(request.headers.get("content-length")) > 32000)
    return reply(413, { error: "payload_too_large" });
  let data;
  try {
    const raw = await request.text();
    if (raw.length > 16000) return reply(413, { error: "payload_too_large" });
    data = JSON.parse(raw);
  } catch {
    return reply(400, { error: "invalid_json" });
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    return reply(400, { error: "invalid_payload" });
  const fields = [
    "name",
    "company",
    "contact",
    "direction",
    "task",
    "requestId",
  ];
  if (fields.some((key) => typeof data[key] !== "string"))
    return reply(400, { error: "invalid_fields" });
  const name = data.name.trim(),
    contact = data.contact.trim();
  if (
    !name ||
    name.length > 100 ||
    data.company.length > 200 ||
    contact.length > 200 ||
    data.task.length > 5000 ||
    !titles[data.direction] ||
    data.consent !== true ||
    data.website ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      data.requestId,
    ) ||
    (!emailPattern.test(contact) &&
      !(phonePattern.test(contact) && contact.replace(/\D/g, "").length >= 7))
  )
    return reply(400, { error: "validation_failed" });
  if (!env.RESEND_API_KEY || !env.CONTACT_EMAIL_FROM || !env.CONTACT_EMAIL_TO)
    return reply(503, { error: "delivery_not_configured" });
  try {
    const response = await transport("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `altum-${data.requestId}`,
      },
      body: JSON.stringify({
        from: env.CONTACT_EMAIL_FROM,
        to: [env.CONTACT_EMAIL_TO],
        ...(emailPattern.test(contact) ? { reply_to: contact } : {}),
        subject: `ALTUM: ${titles[data.direction]}`,
        text: `Обращение ${data.requestId}\nИмя: ${name}\nКомпания: ${data.company.trim() || "Не указана"}\nКонтакт: ${contact}\nНаправление: ${titles[data.direction]}\n\n${data.task.trim() || "Описание не указано"}\n\nСогласие на обработку персональных данных: подтверждено`,
      }),
    });
    const delivery = await response.json();
    if (!response.ok || typeof delivery.id !== "string" || !delivery.id)
      return reply(502, { error: "email_delivery_failed" });
    // Notification contains only a direction and reference, no personal data or project materials.
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      try {
        await transport(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            method: "POST",
            signal: AbortSignal.timeout(5000),
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: env.TELEGRAM_CHAT_ID,
              text: `Новая заявка ALTUM\n${titles[data.direction]}\nНомер: ${data.requestId}\nПодробности отправлены на корпоративную почту.`,
            }),
          },
        );
      } catch {
        /* Email is already accepted; optional notification must not provoke a duplicate lead. */
      }
    }
    return reply(200, { delivered: true, receipt: delivery.id });
  } catch {
    return reply(502, { error: "email_delivery_unconfirmed" });
  }
}

export default {
  fetch(request) {
    return handleContact(request, {
      ...process.env,
      CONTACT_ALLOWED_ORIGINS: [
        "https://altum.kz",
        "https://www.altum.kz",
        "https://altum-consulting.vercel.app",
      ].join(","),
      CONTACT_EMAIL_TO: "contact@altum.kz",
      CONTACT_EMAIL_FROM:
        process.env.CONTACT_EMAIL_FROM ||
        "ALTUM Consulting <forms@notify.ispringsolutions.kz>",
    });
  },
};
