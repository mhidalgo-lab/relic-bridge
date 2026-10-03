// SPDX-License-Identifier: Apache-2.0
// P2-19: a stand-in for api.newrelic.com for the image smoke test. It answers every NerdGraph request with one fixed
// identity so that `credential add` (which validates the key) works without a real key or network access. Runs in a
// throwaway container on a private docker network; the smoke test points the image at it with NODE_EXTRA_CA_CERTS.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';

const body = JSON.stringify({
  data: {
    actor: {
      user: { id: 1, email: 'smoke@example.invalid', name: 'Smoke' },
      accounts: [{ id: 1, name: 'Smoke account' }],
    },
  },
});

createServer({ key: readFileSync('/certs/key.pem'), cert: readFileSync('/certs/cert.pem') }, (req, res) => {
  req.resume();
  res.writeHead(200, { 'content-type': 'application/json' }).end(body);
}).listen(443, '0.0.0.0');
