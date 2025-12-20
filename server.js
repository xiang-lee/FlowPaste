import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.join(__dirname, 'dist');
const API_BASE =
  process.env.AI_BUILDER_BASE_URL ||
  process.env.VITE_AI_BUILDER_BASE_URL ||
  'https://space.ai-builders.com/backend';
const API_TOKEN = process.env.AI_BUILDER_TOKEN || process.env.VITE_AI_BUILDER_TOKEN;

const app = express();

app.use(express.static(distPath, { maxAge: '1y', etag: true }));

app.use('/api', async (req, res) => {
  try {
    const targetUrl = API_BASE + req.originalUrl.replace(/^\/api/, '');
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    if (API_TOKEN) {
      headers.authorization = `Bearer ${API_TOKEN}`;
    }
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
      duplex: 'half',
    });
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'transfer-encoding') return;
      res.setHeader(key, value);
    });
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    console.error('Proxy error', err);
    res.status(502).json({ error: 'proxy_error', message: 'Failed to reach backend' });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

const port = Number(process.env.PORT || 8000);
app.listen(port, '0.0.0.0', () => {
  console.log(`FlowPaste server running on http://0.0.0.0:${port}`);
});
