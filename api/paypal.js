export const config = {
  runtime: 'edge',
  maxDuration: 30,
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

// 금액은 서버에서만 결정 (클라이언트 조작 방지)
const TIER_AMOUNTS = {
  spark:  '2.99',
  soul:   '9.99',
  unlock: '6.99',
};
const CURRENCY = 'USD';

function apiBase() {
  return (process.env.PAYPAL_ENV || 'live') === 'sandbox'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function getAccessToken() {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PayPal credentials not configured');
  const res = await fetch(apiBase() + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(id + ':' + secret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error('OAuth failed: ' + (data.error_description || res.status));
  }
  return data.access_token;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const tier = body.tier;
  const amount = TIER_AMOUNTS[tier];
  if (!amount) return json({ error: 'Invalid tier' }, 400);

  try {
    const token = await getAccessToken();

    // ---- 주문 생성 ----
    if (body.action === 'create') {
      const res = await fetch(apiBase() + '/v2/checkout/orders', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [{
            description: 'BirthCode — ' + tier,
            amount: { currency_code: CURRENCY, value: amount },
          }],
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.id) {
        return json({ error: 'create-order failed', detail: data }, 502);
      }
      return json({ id: data.id });
    }

    // ---- 주문 캡처 + 검증 ----
    if (body.action === 'capture') {
      const orderID = body.orderID;
      if (!orderID) return json({ error: 'Missing orderID' }, 400);

      const res = await fetch(apiBase() + '/v2/checkout/orders/' + orderID + '/capture', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
      });
      const data = await res.json();

      // 캡처 결과 검증: 주문 완료 + 금액/통화가 서버 기준과 정확히 일치해야 통과
      const capture = data?.purchase_units?.[0]?.payments?.captures?.[0];
      const ok =
        res.ok &&
        data.status === 'COMPLETED' &&
        capture &&
        capture.status === 'COMPLETED' &&
        capture.amount?.value === amount &&
        capture.amount?.currency_code === CURRENCY;

      if (!ok) {
        return json({ ok: false, error: 'capture not verified', detail: data }, 402);
      }
      return json({ ok: true, tier, captureId: capture.id });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (error) {
    return json({ error: 'Internal server error', detail: error.message }, 500);
  }
}
