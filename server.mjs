import { createServer as createHttpServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isProduction = process.argv.includes('--prod') || process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT) || 5173;
const requestTimeoutMs = 10000;
const defaultFailurePatterns = ['activation_key not found'];
const textContentPattern = /^(text\/|application\/(json|xml|xhtml\+xml|javascript))/i;

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

function getMimeType(filePath) {
  return mimeTypes[path.extname(filePath)] ?? 'application/octet-stream';
}

function normalizeError(error) {
  const code = error?.cause?.code ?? error?.code ?? 'UNKNOWN';

  if (code === 'ENOTFOUND') {
    return 'DNS lookup failed for this URL.';
  }

  if (code === 'ECONNREFUSED') {
    return 'The remote server refused the connection.';
  }

  if (code === 'ECONNRESET') {
    return 'The remote server reset the connection.';
  }

  if (code === 'ETIMEDOUT' || error?.name === 'TimeoutError') {
    return 'The request timed out before the server responded.';
  }

  if (error?.name === 'AbortError') {
    return 'The request took too long and was stopped.';
  }

  return 'The server could not reach this URL.';
}

function normalizeFailurePatterns(patterns) {
  if (!Array.isArray(patterns)) {
    return defaultFailurePatterns;
  }

  const cleanedPatterns = patterns
    .map((pattern) => (typeof pattern === 'string' ? pattern.trim().toLowerCase() : ''))
    .filter(Boolean);

  return cleanedPatterns.length > 0 ? cleanedPatterns : defaultFailurePatterns;
}

function buildSnippet(bodyText, searchIndex, phraseLength) {
  const snippetRadius = 80;
  const snippetStart = Math.max(0, searchIndex - snippetRadius);
  const snippetEnd = Math.min(bodyText.length, searchIndex + phraseLength + snippetRadius);
  const rawSnippet = bodyText.slice(snippetStart, snippetEnd).replace(/\s+/g, ' ').trim();

  return rawSnippet.length > 0 ? rawSnippet : null;
}

function inspectBodyContent(bodyText, failurePatterns) {
  const normalizedBody = bodyText.toLowerCase();

  for (const pattern of failurePatterns) {
    const matchIndex = normalizedBody.indexOf(pattern);

    if (matchIndex !== -1) {
      return {
        matchedPattern: pattern,
        snippet: buildSnippet(bodyText, matchIndex, pattern.length),
      };
    }
  }

  return null;
}

async function readJsonBody(request) {
  let rawBody = '';

  for await (const chunk of request) {
    rawBody += chunk;

    if (rawBody.length > 64 * 1024) {
      throw new Error('Request body too large.');
    }
  }

  return rawBody ? JSON.parse(rawBody) : {};
}

async function checkUrl(targetUrl, failurePatterns = defaultFailurePatterns) {
  let parsedUrl;

  try {
    parsedUrl = new URL(targetUrl);
  } catch (error) {
    return {
      status: 'invalid',
      detail: 'Use a full http:// or https:// URL to test.',
      checkedAt: Date.now(),
    };
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return {
      status: 'invalid',
      detail: 'Only http:// and https:// links can be tested.',
      checkedAt: Date.now(),
    };
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch(parsedUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.8',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        'user-agent': 'Keygen-Link-Checker/1.0',
      },
    });

    const finalUrl = response.url || parsedUrl.toString();
    const redirectNote = finalUrl !== parsedUrl.toString() ? ` -> ${finalUrl}` : '';
    const contentType = response.headers.get('content-type') ?? 'unknown';
    let contentMatch = null;

    if (textContentPattern.test(contentType)) {
      const bodyText = await response.text();
      contentMatch = inspectBodyContent(bodyText, failurePatterns);
    }

    if (contentMatch) {
      return {
        status: 'not-working',
        detail: `Matched failure phrase: "${contentMatch.matchedPattern}"${redirectNote}`,
        checkedAt: Date.now(),
        finalUrl,
        httpStatus: response.status,
        contentType,
        matchedPattern: contentMatch.matchedPattern,
        snippet: contentMatch.snippet,
      };
    }

    return {
      status: response.ok ? 'working' : 'not-working',
      detail: `HTTP ${response.status}${redirectNote}`,
      checkedAt: Date.now(),
      finalUrl,
      httpStatus: response.status,
      contentType,
    };
  } catch (error) {
    return {
      status: 'blocked',
      detail: normalizeError(error),
      checkedAt: Date.now(),
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function serveProductionAsset(request, response) {
  const distRoot = path.join(__dirname, 'dist');
  const requestPath = new URL(request.url, `http://${request.headers.host}`).pathname;
  const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const cleanPath = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(distRoot, cleanPath);

  try {
    const stats = await fs.stat(filePath);

    if (stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    const fileContents = await fs.readFile(filePath);
    response.statusCode = 200;
    response.setHeader('Content-Type', getMimeType(filePath));
    response.end(fileContents);
    return;
  } catch (error) {
    const indexPath = path.join(distRoot, 'index.html');
    const indexHtml = await fs.readFile(indexPath, 'utf8');
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(indexHtml);
  }
}

async function createAppServer() {
  let vite;

  if (!isProduction) {
    vite = await createViteServer({
      appType: 'custom',
      server: {
        middlewareMode: true,
      },
    });
  }

  const server = createHttpServer(async (request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);

    if (requestUrl.pathname === '/__fixtures__/activation-key-missing') {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<html><body><h1>activation_key not found</h1><p>The key you entered does not exist.</p></body></html>');
      return;
    }

    if (requestUrl.pathname === '/__fixtures__/healthy') {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<html><body><h1>Activation succeeded</h1><p>The content loaded without known failure phrases.</p></body></html>');
      return;
    }

    if (requestUrl.pathname === '/api/check') {
      const isPost = request.method === 'POST';
      let payload = {};

      if (isPost) {
        try {
          payload = await readJsonBody(request);
        } catch (error) {
          sendJson(response, 400, {
            status: 'invalid',
            detail: 'The checker request body is invalid.',
            checkedAt: Date.now(),
          });
          return;
        }
      }

      const targetUrl = isPost ? payload.url : requestUrl.searchParams.get('url');
      const failurePatterns = normalizeFailurePatterns(
        isPost ? payload.failurePatterns : requestUrl.searchParams.getAll('pattern'),
      );

      if (!targetUrl) {
        sendJson(response, 400, {
          status: 'invalid',
          detail: 'A URL is required for testing.',
          checkedAt: Date.now(),
        });
        return;
      }

      const result = await checkUrl(targetUrl, failurePatterns);
      sendJson(response, 200, result);
      return;
    }

    if (vite) {
      vite.middlewares(request, response, async () => {
        try {
          const templatePath = path.join(__dirname, 'index.html');
          const rawTemplate = await fs.readFile(templatePath, 'utf8');
          const html = await vite.transformIndexHtml(requestUrl.pathname, rawTemplate);
          response.statusCode = 200;
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(html);
        } catch (error) {
          vite.ssrFixStacktrace(error);
          response.statusCode = 500;
          response.end(error.message);
        }
      });
      return;
    }

    await serveProductionAsset(request, response);
  });

  server.listen(port, () => {
    const modeLabel = isProduction ? 'production' : 'development';
    console.log(`Keygen server running in ${modeLabel} mode on http://localhost:${port}`);
  });
}

createAppServer();
