const axios = require('axios');
const zlib = require('zlib');
const { LRUCache } = require('lru-cache');

// إعدادات الكاش
const cacheOptions = {
  max: 100,
  ttl: 5 * 60 * 1000
};
const cache = new LRUCache(cacheOptions);

// دالة ضغط Gzip
function tryGzip(req, res, buffer) {
  const acceptEncoding = req.headers['accept-encoding'] || '';
  if (acceptEncoding.includes('gzip')) {
    res.setHeader('Content-Encoding', 'gzip');
    return zlib.gzipSync(buffer);
  }
  return buffer;
}

module.exports.handler = async function(event, context) {
  const targetUrl = event.queryStringParameters.url;
  if (!targetUrl) {
    return {
      statusCode: 400,
      body: "❌ يجب وضع رابط في ?url="
    };
  }

  try {
    // التحقق من وجود الملف في الكاش
    if (cache.has(targetUrl)) {
      const cached = cache.get(targetUrl);
      const compressed = tryGzip(event, {}, Buffer.from(cached.data, 'utf8'));
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
        body: compressed.toString('utf-8')
      };
    }

    const response = await axios.get(targetUrl, { responseType: 'stream', timeout: 15000 });
    const contentType = response.headers['content-type'];

    // التعامل مع ملفات m3u8
    if (contentType.includes("application/vnd.apple.mpegurl")) {
      let playlist = '';
      response.data.setEncoding('utf8');
      for await (const chunk of response.data) {
        playlist += chunk;
      }
      cache.set(targetUrl, { data: playlist, isPlaylist: true });

      const compressed = tryGzip(event, {}, Buffer.from(playlist, 'utf8'));
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
        body: compressed.toString('utf-8')
      };
    }

    // التعامل مع ملفات أخرى (مثل TS)
    const chunks = [];
    response.data.on('data', chunk => chunks.push(chunk));

    response.data.on('end', () => {
      const buffer = Buffer.concat(chunks);
      if (buffer.length < 5 * 1024 * 1024) {
        cache.set(targetUrl, { data: buffer, contentType });
      }
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': contentType },
      body: response.data
    };
  } catch (err) {
    console.error("❌ خطأ أثناء التحميل:", err.message);
    return {
      statusCode: 500,
      body: "❌ فشل الاتصال بالرابط المطلوب."
    };
  }
};
