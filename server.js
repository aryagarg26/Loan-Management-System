'use strict';

// Tiny JSON-file server. No database and no third-party npm packages are needed.
// Start with: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY_BYTES = 1024 * 1024;
const SESSION_COOKIE = 'loandesk_session';
const SESSION_MAX_AGE = 8 * 60 * 60 * 1000;
const sessions = new Map();
const DEMO_ACCOUNTS = [
  { id: 'borrower-demo', username: 'borrower', password: 'borrower123', role: 'borrower', name: 'Priya Sharma', phone: '9876543210', email: 'priya.sharma@example.com' },
  { id: 'manager-demo', username: 'manager', password: 'manager123', role: 'manager', name: 'Bank Manager', phone: '', email: 'manager@loandesk.local' }
];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(payload));
}

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!parsed || !Array.isArray(parsed.loans)) throw new Error('data.json must contain a loans array');
    let changed = false;
    if (!Array.isArray(parsed.users) || !parsed.users.length) {
      parsed.users = DEMO_ACCOUNTS.map(({ password, ...account }) => {
        const salt = crypto.randomBytes(16).toString('hex');
        return { ...account, passwordSalt: salt, passwordHash: crypto.scryptSync(password, salt, 64).toString('hex') };
      });
      changed = true;
    }
    const demoBorrower = parsed.users.find((user) => user.role === 'borrower' && user.username === 'borrower');
    if (demoBorrower) {
      parsed.loans.forEach((loan) => {
        if (!loan.ownerId && loan.applicant === demoBorrower.name) {
          loan.ownerId = demoBorrower.id;
          changed = true;
        }
      });
    }
    if (changed) {
      writeStore(parsed);
    }
    return parsed;
  } catch (error) {
    throw new Error(`Could not read data.json: ${error.message}`);
  }
}

function writeStore(store) {
  const temporaryFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, `${JSON.stringify({ loans: store.loans, users: store.users }, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryFile, DATA_FILE);
}

function publicUser(user) {
  return { id: user.id, username: user.username, role: user.role, name: user.name, phone: user.phone, email: user.email };
}

function requestSession(request, store) {
  const cookies = String(request.headers.cookie || '').split(';').map((item) => item.trim());
  const sessionCookie = cookies.find((item) => item.startsWith(`${SESSION_COOKIE}=`));
  if (!sessionCookie) return null;
  const token = sessionCookie.slice(SESSION_COOKIE.length + 1);
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  const user = store.users.find((item) => item.id === session.userId);
  return user ? { token, user } : null;
}

function requireSession(request, response, store, role) {
  const session = requestSession(request, store);
  if (!session) {
    sendJson(response, 401, { error: 'Please sign in to continue.' });
    return null;
  }
  if (role && session.user.role !== role) {
    sendJson(response, 403, { error: 'You do not have permission to perform this action.' });
    return null;
  }
  return session;
}

function createLoanId(loans) {
  const maxSuffix = loans.reduce((max, loan) => {
    const match = String(loan.id).match(/(\d{4})$/);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 1000);
  return `LN-${new Date().getFullYear()}-${String(maxSuffix + 1).padStart(4, '0')}`;
}

function updateLoan(loan, action) {
  if (action === 'reject' && ['Submitted', 'Under Review', 'Approved'].includes(loan.status)) {
    loan.status = 'Rejected';
    return;
  }
  if (action === 'next') {
    const transitions = { Submitted: 'Under Review', 'Under Review': 'Approved', Approved: 'Disbursed', Disbursed: 'Repaying' };
    const nextStatus = transitions[loan.status];
    if (!nextStatus) throw new Error('This application cannot move to the next stage.');
    loan.status = nextStatus;
    if (nextStatus === 'Disbursed') loan.disbursedDate = new Date().toISOString().slice(0, 10);
    return;
  }
  if (action === 'payment' && loan.status === 'Repaying') {
    if (loan.paidInstallments >= loan.tenureMonths) {
      loan.status = 'Closed';
      return;
    }
    loan.paidInstallments += 1;
    if (loan.paidInstallments >= loan.tenureMonths) loan.status = 'Closed';
    return;
  }
  if (action === 'close' && loan.status === 'Repaying' && loan.paidInstallments >= loan.tenureMonths) {
    loan.status = 'Closed';
    return;
  }
  throw new Error('This action is not available for the current application status.');
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let totalBytes = 0;
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      totalBytes += Buffer.byteLength(chunk, 'utf8');
      if (totalBytes > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large.'));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (_error) {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

function serveStatic(request, response, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch (_error) {
    response.writeHead(400);
    response.end('Bad request');
    return;
  }
  if (decodedPath === '/data.json') {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  if (decodedPath === '/') decodedPath = '/index.html';
  const absolutePath = path.resolve(ROOT, `.${decodedPath}`);
  if (!absolutePath.startsWith(`${ROOT}${path.sep}`) && absolutePath !== ROOT) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }
  fs.stat(absolutePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    const contentType = MIME_TYPES[path.extname(absolutePath).toLowerCase()] || 'application/octet-stream';
    response.writeHead(200, {
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': absolutePath.endsWith('data.json') ? 'no-store' : 'no-cache'
    });
    const stream = fs.createReadStream(absolutePath);
    stream.on('error', () => {
      if (!response.headersSent) response.writeHead(500);
      response.end('Could not read file');
    });
    stream.pipe(response);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);

  if (url.pathname === '/api/login' && request.method === 'POST') {
    try {
      const payload = await readRequestBody(request);
      const store = readStore();
      const user = store.users.find((item) => item.username === String(payload.username || '').trim().toLowerCase() && item.role === payload.role);
      const passwordHash = user && crypto.scryptSync(String(payload.password || ''), user.passwordSalt, 64);
      if (!user || !crypto.timingSafeEqual(passwordHash, Buffer.from(user.passwordHash, 'hex'))) {
        sendJson(response, 401, { error: 'Username or password is incorrect.' });
        return;
      }
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_MAX_AGE });
      response.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE / 1000}`);
      sendJson(response, 200, { user: publicUser(user) });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (url.pathname === '/api/session' && request.method === 'GET') {
    const session = requireSession(request, response, readStore());
    if (session) sendJson(response, 200, { user: publicUser(session.user) });
    return;
  }

  if (url.pathname === '/api/logout' && request.method === 'POST') {
    const store = readStore();
    const session = requestSession(request, store);
    if (session) sessions.delete(session.token);
    response.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/loans' && request.method === 'GET') {
    const store = readStore();
    const session = requireSession(request, response, store);
    if (!session) return;
    const visibleLoans = session.user.role === 'manager'
      ? store.loans
      : store.loans.filter((loan) => loan.ownerId === session.user.id);
    sendJson(response, 200, { loans: visibleLoans });
    return;
  }

  if (url.pathname === '/api/loans' && request.method === 'POST') {
    const store = readStore();
    const session = requireSession(request, response, store, 'borrower');
    if (!session) return;
    try {
      const payload = await readRequestBody(request);
      const amount = Number(payload.amount);
      const tenureMonths = Number(payload.tenureMonths);
      const purpose = String(payload.purpose || '').trim();
      if (!Number.isFinite(amount) || amount < 1000 || amount > 100000000 || !Number.isInteger(tenureMonths) || tenureMonths < 1 || tenureMonths > 360 || !purpose || purpose.length > 60) {
        sendJson(response, 400, { error: 'Enter a valid amount, purpose, and tenure.' });
        return;
      }
      const loan = {
        id: createLoanId(store.loans), ownerId: session.user.id, applicant: session.user.name,
        phone: session.user.phone, email: session.user.email, amount, purpose, tenureMonths,
        annualRate: 12, appliedDate: new Date().toISOString().slice(0, 10), status: 'Submitted',
        paidInstallments: 0, disbursedDate: null, createdAt: new Date().toISOString()
      };
      store.loans.unshift(loan);
      writeStore(store);
      sendJson(response, 201, { loan });
    } catch (error) {
      const status = /valid JSON|too large/.test(error.message) ? 400 : 500;
      sendJson(response, status, { error: error.message });
    }
    return;
  }

  const actionMatch = url.pathname.match(/^\/api\/loans\/([^/]+)\/action$/);
  if (actionMatch && request.method === 'POST') {
    const store = readStore();
    const session = requireSession(request, response, store, 'manager');
    if (!session) return;
    try {
      const loanId = decodeURIComponent(actionMatch[1]);
      const loan = store.loans.find((item) => item.id === loanId);
      if (!loan) {
        sendJson(response, 404, { error: 'Loan application not found.' });
        return;
      }
      const payload = await readRequestBody(request);
      updateLoan(loan, payload.action);
      writeStore(store);
      sendJson(response, 200, { loan });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    sendJson(response, 404, { error: 'API endpoint not found.' });
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', 'Allow': 'GET, HEAD' });
    response.end('Method not allowed');
    return;
  }
  serveStatic(request, response, url.pathname);
});

readStore();
server.listen(PORT, HOST, () => {
  console.log(`LoanDesk is running at http://${HOST}:${PORT}`);
  console.log(`JSON data file: ${DATA_FILE}`);
  console.log('Stop the server with Ctrl+C. Demo only; do not use real customer data.');
});
