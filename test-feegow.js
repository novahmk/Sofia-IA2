const https = require('https');
const token = process.env.TOKEN;

// Feegow public API - testar múltiplos formatos de endpoint
const tests = [
  // GET requests
  { method: 'GET', url: 'https://api.feegow.com.br/v1/specialties/list' },
  { method: 'GET', url: 'https://api.feegow.com.br/v1/professionals/list' },
  { method: 'GET', url: 'https://api.feegow.com.br/v1/patients/list' },
  { method: 'GET', url: 'https://api.feegow.com.br/v1/appoints/list' },
  { method: 'GET', url: 'https://api.feegow.com.br/v1/procedures/list' },
  { method: 'GET', url: 'https://api.feegow.com.br/v1/schedule/list' },
  // POST requests (Feegow pode exigir POST)  
  { method: 'POST', url: 'https://api.feegow.com.br/v1/specialties/list' },
  { method: 'POST', url: 'https://api.feegow.com.br/v1/professionals/list' },
  { method: 'POST', url: 'https://api.feegow.com.br/v1/patients/list' },
  { method: 'POST', url: 'https://api.feegow.com.br/v1/appoints/list' },
  { method: 'POST', url: 'https://api.feegow.com.br/v1/procedures/list' },
  { method: 'POST', url: 'https://api.feegow.com.br/v1/schedule/list' },
  // Sem /list
  { method: 'GET', url: 'https://api.feegow.com.br/v1/specialties' },
  { method: 'GET', url: 'https://api.feegow.com.br/v1/professionals' },
  { method: 'GET', url: 'https://api.feegow.com.br/v1/appoints' },
  // Tentativa com "Authorization: Bearer" ao invés de x-access-token
  { method: 'GET', url: 'https://api.feegow.com.br/v1/specialties/list', authHeader: 'bearer' },
  { method: 'GET', url: 'https://api.feegow.com.br/v1/professionals/list', authHeader: 'bearer' },
];

async function test(t) {
  return new Promise((resolve) => {
    const url = new URL(t.url);
    const headers = { 'Content-Type': 'application/json' };
    if (t.authHeader === 'bearer') {
      headers['Authorization'] = 'Bearer ' + token;
    } else {
      headers['x-access-token'] = token;
    }
    const req = https.request(url, { method: t.method, headers }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        const isJson = body.startsWith('{') || body.startsWith('[');
        const auth = t.authHeader === 'bearer' ? ' [Bearer]' : '';
        const preview = isJson ? ' -> ' + body.substring(0, 120) : '';
        resolve(t.method + ' ' + res.statusCode + ' ' + t.url + auth + preview);
      });
    });
    req.on('error', (e) => resolve(t.method + ' ERR ' + t.url + ' ' + e.message));
    if (t.method === 'POST') req.write('{}');
    req.end();
  });
}

Promise.all(tests.map(test)).then(r => r.forEach(l => console.log(l)));
