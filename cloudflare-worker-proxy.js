/* ══════════════════════════════════════════════════════════════
   Cloudflare Worker — بروكسي بث فيديو (m3u8 / ts / http)
   يعمل "streaming" حقيقي: يمرر البيانات لحظة وصولها بدون تجميعها
   بالذاكرة، وهذا ضروري جداً للبث المباشر (live) اللي ما ينتهي أبداً.

   ⚠️ إذا الووركر القديم يستخدم response.text() أو arrayBuffer()
   قبل الإرجاع، فهذا يسبب التعليق مع أي بث حي — لازم تمرير الـ body
   كـ ReadableStream مباشرة كما بالأسفل.
   ══════════════════════════════════════════════════════════════ */

export default {
  async fetch(request) {
    const { pathname, searchParams } = new URL(request.url);

    // دعم CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (pathname !== '/proxy') {
      return new Response('Not found', { status: 404, headers: corsHeaders() });
    }

    const targetUrl = searchParams.get('url');
    if (!targetUrl) {
      return new Response('Missing url param', { status: 400, headers: corsHeaders() });
    }

    let target;
    try {
      target = new URL(targetUrl);
    } catch (e) {
      return new Response('Invalid url', { status: 400, headers: corsHeaders() });
    }

    // (اختياري لكن مهم للأمان) قيّد الدومينات المسموحة هنا إذا تحب
    // const allowedHosts = ['example.com'];
    // if (!allowedHosts.includes(target.hostname)) {
    //   return new Response('Host not allowed', { status: 403, headers: corsHeaders() });
    // }

    // نمرر الـ Range header (مهم جداً لـ seek وبعض مشغلات m3u8/ts)
    const upstreamHeaders = new Headers();
    const range = request.headers.get('range');
    if (range) upstreamHeaders.set('range', range);
    upstreamHeaders.set('user-agent', 'Mozilla/5.0 (compatible; StreamProxy/1.0)');

    let upstreamResp;
    try {
      upstreamResp = await fetch(target.toString(), {
        headers: upstreamHeaders,
        // مهم: لا نستخدم cf: {cacheEverything:true} مع بث مباشر لا نهائي
        redirect: 'follow'
      });
    } catch (e) {
      return new Response('Upstream fetch failed: ' + e.message, { status: 502, headers: corsHeaders() });
    }

    if (!upstreamResp.ok && upstreamResp.status !== 206) {
      return new Response('Upstream error ' + upstreamResp.status, {
        status: upstreamResp.status,
        headers: corsHeaders()
      });
    }

    // إعادة كتابة روابط m3u8 الداخلية (segments/بلايليست فرعي) لتمر عبر نفس البروكسي
    const contentType = upstreamResp.headers.get('content-type') || '';
    const isPlaylist = pathname.endsWith('.m3u8') || target.pathname.endsWith('.m3u8') || contentType.includes('mpegurl');

    const respHeaders = new Headers(corsHeaders());
    // نمرر content-type/length/range الأصلية عشان المشغل يفهم نوع الوسائط والمدى
    ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'].forEach(h => {
      const v = upstreamResp.headers.get(h);
      if (v) respHeaders.set(h, v);
    });

    if (isPlaylist) {
      // البلايليست نصوصي وصغير نسبياً، آمن نعالجه كنص ونعيد كتابة الروابط بداخله
      const text = await upstreamResp.text();
      const rewritten = rewritePlaylist(text, target, self_origin(request));
      respHeaders.set('content-type', 'application/vnd.apple.mpegurl');
      respHeaders.delete('content-length'); // تغيّر الطول بعد إعادة الكتابة
      return new Response(rewritten, { status: upstreamResp.status, headers: respHeaders });
    }

    // لأي شيء آخر (segments .ts, بث TS خام مباشر... إلخ):
    // نمرر الـ body كـ stream مباشرة بدون تجميعه بالذاكرة — هذا هو المفتاح لمنع التعليق
    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: respHeaders
    });
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges'
  };
}

function self_origin(request) {
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}

// يحول كل رابط داخل ملف m3u8 (نسبي أو مطلق) ليمر عبر نفس البروكسي
function rewritePlaylist(text, baseUrl, proxyOrigin) {
  return text.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    let abs;
    try { abs = new URL(trimmed, baseUrl).toString(); } catch (e) { return line; }
    return `${proxyOrigin}/proxy?url=${encodeURIComponent(abs)}`;
  }).join('\n');
}
